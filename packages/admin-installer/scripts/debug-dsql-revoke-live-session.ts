/**
 * Probe whether Aurora DSQL permits `AWS IAM REVOKE` on a mapping that a live
 * session is authenticated under, and what happens to that session afterwards.
 *
 * The question matters because the install DDL is a candidate site for a
 * revoke-then-re-grant of the app's IAM-to-PG mapping (making the mapping
 * converge on the role's current principal rather than trusting whatever row it
 * finds). A reinstall of a running app can overlap with connections the app's
 * Lambda already holds, so three behaviours have to be known:
 *
 *   1. Does `AWS IAM REVOKE` succeed while a session authorized by the mapping
 *      is open, or does DSQL refuse it the way PG refuses `DROP ROLE` for a
 *      role with dependent objects?
 *   2. Does the already-open session keep working after the revoke, or is it
 *      terminated?
 *   3. Does a re-grant restore the ability to open new sessions?
 *   4. If the open session broke, does it recover once the mapping is back, or
 *      is the connection dead for good?
 *   5. Can the revoke and the re-grant run inside one explicit transaction, so
 *      no window exists in which the mapping is absent?
 *
 * AWS documents neither the answer nor the question, so only the cluster can
 * settle it.
 *
 * The probe is self-contained: it creates its own uniquely-named PG role, maps
 * it to the ARN of the caller's own principal (`<stackPrefix>-app-admin-role`,
 * the federated admin entry point, which holds plain `dsql:DbConnect` where
 * install-ddl-role holds only `dsql:DbConnectAdmin`), exercises the sequence,
 * and drops both the mapping and the role on the way out. It never reads or mutates an app's mapping, so it is
 * safe to run against a cluster with installed apps. It does write DDL, unlike
 * debug-dsql-inspect.ts.
 *
 * Same credential and bootstrap path as debug-dsql-inspect.ts: admin
 * connections need dsql:DbConnectAdmin, which only the install-ddl-role holds,
 * so this attaches a uniquely-named temp policy and detaches it on exit.
 *
 * Run via:
 *   pnpm -F @starkeep/admin-installer debug:dsql-revoke-live-session
 *
 * Pass `--starkeep-dir <path>` to target a stack other than the one
 * `$STARKEEP_DIR/config.json` names (an e2e run-state dir, for instance), and
 * `--as-role <roleName>` to map the probe role to a principal other than
 * `<stackPrefix>-app-admin-role`. Whatever `--as-role` names must be the role
 * the ambient credentials resolve to, since the probe session is opened with
 * those credentials.
 */

// First import: load repo-root .env / .env.local so STARKEEP_DIR is populated.
import "@starkeep/app-client/load-env";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { IAMClient, PutRolePolicyCommand, DeleteRolePolicyCommand } from "@aws-sdk/client-iam";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import pg from "pg";

interface Creds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface StarkeepConfig {
  accountId: string;
  stackPrefix: string;
  managerRoleArn: string;
  auroraEndpoint: string;
  region?: string | null;
}

function loadStarkeepConfig(dir: string): StarkeepConfig {
  return JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as StarkeepConfig;
}

function loadBaseCreds(): Creds {
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    };
  }
  // The cached file stores `expiration` as an ISO string the AWS SDK would call
  // `.getTime()` on; drop it and let AWS enforce expiry server-side.
  const raw = JSON.parse(
    readFileSync(join(homedir(), ".starkeep", "cloud-credentials.json"), "utf8"),
  ) as Creds & { expiration?: string };
  return {
    accessKeyId: raw.accessKeyId,
    secretAccessKey: raw.secretAccessKey,
    sessionToken: raw.sessionToken,
  };
}

async function assume(
  arn: string,
  creds: Creds,
  sessionName: string,
  region: string,
): Promise<Creds> {
  const sts = new STSClient({ region, credentials: creds });
  const r = await sts.send(
    new AssumeRoleCommand({ RoleArn: arn, RoleSessionName: sessionName, DurationSeconds: 900 }),
  );
  const c = r.Credentials!;
  return {
    accessKeyId: c.AccessKeyId!,
    secretAccessKey: c.SecretAccessKey!,
    sessionToken: c.SessionToken!,
  };
}

function pgErr(err: unknown): string {
  const e = err as { message?: string; code?: string; severity?: string };
  const code = e.code ? ` [${e.severity ?? "ERROR"} ${e.code}]` : "";
  return `${e.message ?? String(err)}${code}`;
}

/** Connect as `user`, signing a fresh token per attempt. */
async function connectAs(
  user: "admin" | string,
  hostname: string,
  region: string,
  creds: Creds,
  attempts: number,
): Promise<pg.Client> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const signer = new DsqlSigner({ hostname, region, credentials: creds });
      const token =
        user === "admin"
          ? await signer.getDbConnectAdminAuthToken()
          : await signer.getDbConnectAuthToken();
      const client = new pg.Client({
        host: hostname,
        port: 5432,
        database: "postgres",
        user,
        password: token,
        ssl: { rejectUnauthorized: true },
      });
      await client.connect();
      return client;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dirIdx = args.indexOf("--starkeep-dir");
  const starkeepDir =
    dirIdx >= 0
      ? args[dirIdx + 1]!
      : (process.env.STARKEEP_DIR ?? join(homedir(), ".starkeep"));

  const cfg = loadStarkeepConfig(starkeepDir);
  const region = cfg.region ?? "us-east-2";
  const base = loadBaseCreds();

  const sessionTag = `rvk-${process.pid}`;
  const probeRole = `revoke_probe_${process.pid}`;
  const ddlRoleName = `${cfg.stackPrefix}-install-ddl-role`;
  const ddlRoleArn = `arn:aws:iam::${cfg.accountId}:role/${ddlRoleName}`;
  // The principal the probe session authenticates as. DSQL resolves an
  // assumed-role session to its underlying role ARN, which is why the mapping
  // names the role and not the session.
  const asRoleIdx = args.indexOf("--as-role");
  const asRoleName =
    asRoleIdx >= 0 ? args[asRoleIdx + 1]! : `${cfg.stackPrefix}-app-admin-role`;
  const asRoleArn = `arn:aws:iam::${cfg.accountId}:role/${asRoleName}`;

  console.log(`Target stack : ${cfg.stackPrefix} (${starkeepDir})`);
  console.log(`DSQL cluster : ${cfg.auroraEndpoint}`);
  console.log(`Probe PG role: ${probeRole} -> ${asRoleArn}\n`);

  const mgr = await assume(cfg.managerRoleArn, base, `${sessionTag}-mgr`, region);
  const iam = new IAMClient({ region, credentials: mgr });
  const policyName = `temp-install-ddl-revokeprobe-${sessionTag}`;
  await iam.send(
    new PutRolePolicyCommand({
      RoleName: ddlRoleName,
      PolicyName: policyName,
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Action: ["dsql:DbConnectAdmin", "dsql:DbConnect"], Resource: "*" },
        ],
      }),
    }),
  );

  let exitCode = 0;
  try {
    // IAM propagation to the DSQL data-plane authorizer runs tens of seconds.
    console.log("Waiting 15s for IAM propagation…");
    await new Promise((r) => setTimeout(r, 15_000));
    const ddl = await assume(ddlRoleArn, mgr, `${sessionTag}-ddl`, region);

    const admin = await connectAs("admin", cfg.auroraEndpoint, region, ddl, 10);
    let session: pg.Client | undefined;
    try {
      console.log("=== setup ===");
      await admin.query(`CREATE ROLE "${probeRole}" LOGIN`);
      await admin.query(`AWS IAM GRANT "${probeRole}" TO '${asRoleArn}'`);
      console.log(`created ${probeRole} and granted the mapping`);

      console.log("\n=== 0. open a session under the mapping ===");
      const t0open = Date.now();
      session = await connectAs(probeRole, cfg.auroraEndpoint, region, base, 40);
      console.log(`mapping became usable after ${Math.round((Date.now() - t0open) / 1000)}s`);
      const before = await session.query("SELECT 1 AS ok");
      console.log(`session open, SELECT 1 -> ${before.rows[0].ok}`);

      console.log("\n=== 1. AWS IAM REVOKE with that session still open ===");
      let revokeSucceeded = false;
      try {
        await admin.query(`AWS IAM REVOKE "${probeRole}" FROM '${asRoleArn}'`);
        revokeSucceeded = true;
        console.log("RESULT: revoke SUCCEEDED while a session was live");
      } catch (err) {
        console.log(`RESULT: revoke REFUSED -> ${pgErr(err)}`);
      }

      console.log("\n=== 2. does the open session survive the revoke? ===");
      try {
        const after = await session.query("SELECT 1 AS ok");
        console.log(`RESULT: session SURVIVED, SELECT 1 -> ${after.rows[0].ok}`);
      } catch (err) {
        console.log(`RESULT: session BROKEN -> ${pgErr(err)}`);
      }

      console.log("\n=== 3. can a NEW session still be opened? ===");
      try {
        const fresh = await connectAs(probeRole, cfg.auroraEndpoint, region, base, 1);
        await fresh.end();
        console.log(
          revokeSucceeded
            ? "RESULT: new session ACCEPTED (revoke not yet effective, or not enforced)"
            : "RESULT: new session ACCEPTED (expected — the revoke was refused)",
        );
      } catch (err) {
        console.log(`RESULT: new session REFUSED -> ${pgErr(err)}`);
      }

      if (revokeSucceeded) {
        console.log("\n=== 4. does a re-grant restore new sessions? ===");
        await admin.query(`AWS IAM GRANT "${probeRole}" TO '${asRoleArn}'`);
        const t0 = Date.now();
        try {
          const regranted = await connectAs(probeRole, cfg.auroraEndpoint, region, base, 40);
          await regranted.end();
          console.log(
            `RESULT: re-grant RESTORED access after ${Math.round((Date.now() - t0) / 1000)}s`,
          );
        } catch (err) {
          console.log(`RESULT: re-grant did NOT restore access -> ${pgErr(err)}`);
        }

        console.log("\n=== 5. does the broken session recover after the re-grant? ===");
        try {
          const recovered = await session.query("SELECT 1 AS ok");
          console.log(`RESULT: same connection RECOVERED, SELECT 1 -> ${recovered.rows[0].ok}`);
        } catch (err) {
          console.log(`RESULT: same connection still BROKEN -> ${pgErr(err)}`);
          try {
            const second = await session.query("SELECT 1 AS ok");
            console.log(`   second attempt RECOVERED -> ${second.rows[0].ok}`);
          } catch (err2) {
            console.log(`   second attempt still BROKEN -> ${pgErr(err2)}`);
          }
        }

        console.log("\n=== 6. can revoke + re-grant run in one transaction? ===");
        try {
          await admin.query("BEGIN");
          await admin.query(`AWS IAM REVOKE "${probeRole}" FROM '${asRoleArn}'`);
          await admin.query(`AWS IAM GRANT "${probeRole}" TO '${asRoleArn}'`);
          await admin.query("COMMIT");
          console.log("RESULT: rebind in one transaction COMMITTED");
        } catch (err) {
          console.log(`RESULT: rebind in one transaction REJECTED -> ${pgErr(err)}`);
          await admin.query("ROLLBACK").catch(() => {});
          // Leave the mapping as the single-statement path would: re-grant if
          // the revoke landed before the failure.
          const still = await admin
            .query(`SELECT 1 FROM sys.iam_pg_role_mappings WHERE pg_role_name = $1 AND arn = $2`, [
              probeRole,
              asRoleArn,
            ])
            .catch(() => ({ rowCount: 0 }) as { rowCount: number });
          if (!still.rowCount) {
            await admin
              .query(`AWS IAM GRANT "${probeRole}" TO '${asRoleArn}'`)
              .catch((e: unknown) => console.log(`   re-grant after rollback failed: ${pgErr(e)}`));
            console.log("   mapping restored outside the transaction");
          }
        }
        try {
          const post = await connectAs(probeRole, cfg.auroraEndpoint, region, base, 10);
          await post.end();
          console.log("   new session after step 6: ACCEPTED");
        } catch (err) {
          console.log(`   new session after step 6: REFUSED -> ${pgErr(err)}`);
        }
      }
    } finally {
      console.log("\n=== cleanup ===");
      if (session) await session.end().catch(() => {});
      const mappings = await admin
        .query(
          `SELECT 1 FROM sys.iam_pg_role_mappings WHERE pg_role_name = $1 AND arn = $2`,
          [probeRole, asRoleArn],
        )
        .catch(() => ({ rowCount: 0 }) as { rowCount: number });
      if (mappings.rowCount) {
        await admin
          .query(`AWS IAM REVOKE "${probeRole}" FROM '${asRoleArn}'`)
          .catch((e: unknown) => console.log(`cleanup revoke failed: ${pgErr(e)}`));
      }
      await admin
        .query(`DROP ROLE "${probeRole}"`)
        .catch((e: unknown) => console.log(`cleanup DROP ROLE failed: ${pgErr(e)}`));
      console.log(`dropped ${probeRole}`);
      await admin.end().catch(() => {});
    }
  } catch (err) {
    console.error(`\nProbe failed: ${pgErr(err)}`);
    exitCode = 1;
  } finally {
    await iam
      .send(new DeleteRolePolicyCommand({ RoleName: ddlRoleName, PolicyName: policyName }))
      .catch(() => {});
    console.log("detached temp policy");
  }
  process.exit(exitCode);
}

void main();
