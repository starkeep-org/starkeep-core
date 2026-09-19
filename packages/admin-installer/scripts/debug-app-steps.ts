/**
 * Dump an app's install/uninstall step ledger (`shared.app_install_steps`) and
 * the registry row and IAM-to-PG mapping that go with it.
 *
 * This is the view that exposed the ledger leak: `delete_app_registry` used to
 * clear the ledger mid-uninstall, so the steps after it wrote `done` rows nothing
 * ever cleared, and every uninstall after the first silently skipped its last
 * four steps. Reading the three together — ledger rows, registry row, mapping —
 * is what makes a skipped step visible, because a skipped `delete_app_registry`
 * shows up as a registry row that outlived its uninstall.
 *
 * Read-only unless `--clear` is passed, which drops every ledger row for the app
 * so the next install or uninstall runs its steps instead of skipping them. Use
 * it on a stack whose ledger predates the fix.
 *
 * Same credential and bootstrap path as debug-dsql-inspect.ts: admin connections
 * need dsql:DbConnectAdmin, which only the install-ddl-role holds, so this
 * attaches a uniquely-named temp policy and detaches it on exit.
 *
 * Run via:
 *   pnpm -F @starkeep/admin-installer debug:app-steps -- --app <appId> [--clear]
 */
import "@starkeep/app-client/load-env";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { IAMClient, PutRolePolicyCommand, DeleteRolePolicyCommand } from "@aws-sdk/client-iam";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import pg from "pg";
interface C { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
const dir = process.env.STARKEEP_DIR!;
const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
const region = cfg.region ?? "us-east-2";
const raw = JSON.parse(readFileSync(join(homedir(), ".starkeep", "cloud-credentials.json"), "utf8"));
const base: C = process.env.AWS_ACCESS_KEY_ID
  ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID!, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!, sessionToken: process.env.AWS_SESSION_TOKEN }
  : { accessKeyId: raw.accessKeyId, secretAccessKey: raw.secretAccessKey, sessionToken: raw.sessionToken };
async function assume(arn: string, c: C, n: string): Promise<C> {
  const r = await new STSClient({ region, credentials: c }).send(new AssumeRoleCommand({ RoleArn: arn, RoleSessionName: n, DurationSeconds: 900 }));
  const x = r.Credentials!;
  return { accessKeyId: x.AccessKeyId!, secretAccessKey: x.SecretAccessKey!, sessionToken: x.SessionToken! };
}
const mgr = await assume(cfg.managerRoleArn, base, "ql-mgr");
const iam = new IAMClient({ region, credentials: mgr });
const ddlRole = `${cfg.stackPrefix}-install-ddl-role`;
const pn = `temp-install-ddl-ql-${process.pid}`;
await iam.send(new PutRolePolicyCommand({ RoleName: ddlRole, PolicyName: pn, PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["dsql:DbConnectAdmin"], Resource: "*" }] }) }));
try {
  await new Promise((r) => setTimeout(r, 15000));
  const ddl = await assume(`arn:aws:iam::${cfg.accountId}:role/${ddlRole}`, mgr, "ql-ddl");
  const signer = new DsqlSigner({ hostname: cfg.auroraEndpoint, region, credentials: ddl });
  const c = new pg.Client({ host: cfg.auroraEndpoint, port: 5432, database: "postgres", user: "admin", password: await signer.getDbConnectAdminAuthToken(), ssl: { rejectUnauthorized: true } });
  await c.connect();
  const args = process.argv.slice(2);
  const appIdx = args.indexOf("--app");
  const appId = appIdx >= 0 ? args[appIdx + 1]! : "probe";
  const clear = args.includes("--clear");
  const steps = await c.query(
    `SELECT operation, step, status, updated_at FROM shared.app_install_steps WHERE app_id=$1 ORDER BY operation, updated_at`,
    [appId],
  );
  console.log(`=== app_install_steps for ${appId} ===`);
  for (const r of steps.rows) console.log(`${r.operation.padEnd(10)} ${r.step.padEnd(34)} ${r.status.padEnd(7)} ${new Date(r.updated_at).toISOString()}`);
  const reg = await c.query(`SELECT app_id FROM shared.app_registry WHERE app_id=$1`, [appId]);
  console.log(`\napp_registry row for ${appId}: ${reg.rowCount}`);
  const map = await c.query(
    `SELECT pg_role_name, arn FROM sys.iam_pg_role_mappings WHERE pg_role_name LIKE $1`,
    [`%${appId.replace(/-/g, "_")}%`],
  );
  console.log(`${appId} mapping rows: ${map.rowCount}`, map.rows);
  if (clear) {
    const del = await c.query(`DELETE FROM shared.app_install_steps WHERE app_id=$1`, [appId]);
    console.log(`\ncleared ${del.rowCount} ledger row(s) for ${appId}`);
  }
  await c.end();
} finally {
  await iam.send(new DeleteRolePolicyCommand({ RoleName: ddlRole, PolicyName: pn })).catch(() => {});
}
process.exit(0);
