/**
 * Tier-3 cloud e2e (plan §11): one scripted journey against a real AWS
 * account, idempotent against the dedicated test stack prefix. Steps are
 * ordered and cumulative — `bail: 1` in vitest.config.ts stops the run at the
 * first failure instead of cascading for tens of minutes.
 *
 * Repeat runs against a kept-up stack re-execute every install, which is the
 * idempotency coverage (CloudFormation verify, Pulumi no-change up, DDL
 * re-apply) the plan asks for; the first run against a bare account covers
 * cold start.
 */

import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  startLocalDataServer,
  type LocalDataServer,
} from "@starkeep/testkit";
import {
  installAppDirect,
  driveCreds,
  createRecordWithBytes,
  solidPng,
  type LdsApp,
} from "@starkeep/e2e";
import { signedFetch, type AppCredentials } from "@starkeep/app-client";
import { AWS_TESTS_ENABLED, STACK_PREFIX, REGION, TEARDOWN } from "./env.js";
import { ensureBootstrapStack, type BootstrapOutputs } from "./bootstrap-stack.js";
import { ensureAdminUser } from "./admin-user.js";
import { signInAdmin, runInstallCli, type AdminSession } from "./installers.js";
import {
  runPaths,
  readConfig,
  writeConfig,
  type TestStackConfig,
} from "./run-state.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STARKEEP_APPS_DIR = resolve(REPO_ROOT, "..", "starkeep-apps");

const paths = runPaths(STACK_PREFIX);

// Shared journey state, filled in step order.
let outputs: BootstrapOutputs;
let session: AdminSession;
let config: TestStackConfig;
let lds: LocalDataServer | undefined;
let drive: LdsApp;
let photos: LdsApp;
let syncedRecordId: string;
// Unique per run: the cloud is kept up between runs and dedupes records by
// content hash on live rows, so a constant image would ship only on its very
// first run and report shipped: 0 thereafter. Random colour + size give each
// run a fresh content hash (well over the 24-bit colour space, so collisions
// stay negligible even across a long-lived stack) so the sync genuinely ships.
const photoBytes = solidPng(
  [...randomBytes(3)] as [number, number, number],
  16 + (randomBytes(1)[0] % 48), // 16–63 px; still tiny, still a valid PNG
);

/** HMAC-signed fetch against the real broker: `${apiGatewayUrl}/apps/{appId}`. */
function cloudApp(local: AppCredentials): LdsApp {
  const creds: AppCredentials = {
    appId: local.appId,
    hmacSecret: local.hmacSecret,
    dataServerUrl: `${config.apiGatewayUrl}/apps/${encodeURIComponent(local.appId)}`,
  };
  return { ...creds, fetch: (path, init) => signedFetch(creds, path, init) };
}

function runTeardownScript(script: string): void {
  const result = spawnSync(
    "bash",
    [join(REPO_ROOT, "scripts", script), "--yes", "--prefix", STACK_PREFIX, "--region", REGION],
    {
      stdio: "inherit",
      env: { ...process.env, STARKEEP_DIR: paths.dataDir, AWS_REGION: REGION },
    },
  );
  if (result.status !== 0) {
    throw new Error(`${script} exited with code ${result.status}`);
  }
}

(AWS_TESTS_ENABLED ? describe : describe.skip)(
  `tier-3 cloud journey (prefix ${STACK_PREFIX})`,
  () => {
    afterAll(async () => {
      await lds?.stop();
      if (TEARDOWN === "apps") runTeardownScript("teardown-cloud-data-server.sh");
      if (TEARDOWN === "all") runTeardownScript("teardown-bootstrap.sh");
    });

    it("bootstrap stack: create if missing, verify outputs", async () => {
      const result = await ensureBootstrapStack({ stackPrefix: STACK_PREFIX, region: REGION });
      outputs = result.outputs;
      console.log(
        `[e2e-aws] bootstrap stack ${result.created ? "created" : "verified"}; pool ${outputs.userPoolId}`,
      );
      expect(outputs.userPoolId).toMatch(new RegExp(`^${REGION}_`));

      // Seed (or refresh) the CLI-facing config from stack outputs, keeping
      // any cloud-data-server outputs from a previous kept-up run.
      const previous = readConfig(paths);
      config = {
        ...previous,
        stackPrefix: STACK_PREFIX,
        userPoolId: outputs.userPoolId,
        userPoolClientId: outputs.userPoolClientId,
        identityPoolId: outputs.identityPoolId,
        managerRoleArn: outputs.managerRoleArn,
        permissionsBoundaryArn: outputs.appPermissionsBoundaryArn,
        foundationalPermissionsBoundaryArn: outputs.appFoundationalPermissionsBoundaryArn,
        userDataOwnerPermissionsBoundaryArn: outputs.userDataOwnerPermissionsBoundaryArn,
        pulumiStateBucket: outputs.pulumiStateBucketName,
        appParentDirs: [STARKEEP_APPS_DIR],
      };
      writeConfig(paths, config);
    });

    it("admin user exists and signs in through Cognito + Identity Pool", async () => {
      const admin = await ensureAdminUser(paths, outputs.userPoolId);
      session = await signInAdmin(config, admin);
      expect(session.idToken.split(".")).toHaveLength(3);
      expect(session.awsCredentials.accessKeyId).toBeTruthy();
    });

    it("installs cloud-data-server via the real CLI", async () => {
      await runInstallCli("cli-install-cloud-data-server", [], paths, session);
      // The CLI rewrites config.json with apiGatewayUrl / s3Bucket / auroraEndpoint.
      config = readConfig(paths)!;
      expect(config.apiGatewayUrl).toMatch(/^https:\/\//);
      expect(config.auroraEndpoint).toBeTruthy();

      const health = await fetch(`${config.apiGatewayUrl}/health`);
      expect(health.status).toBe(200);
    });

    it("boots a local data server against the real cloud", async () => {
      // Boot with the Cognito pool config but NO pre-seeded auth.json. The real
      // wizard never injects a token at boot; it signs the user in afterwards
      // through the LDS /auth/tokens handoff (next step). Booting unauthenticated
      // means the sync supervisor stays parked (startOrKickSupervisor gates on a
      // live id token) until that handoff lands — so the later `shipped > 0`
      // assertion genuinely depends on the handoff having started sync.
      // Share the run-state dir as the LDS's STARKEEP_DIR, so config.json (written
      // by the cloud-data-server install) and data.db (the LDS's registry) live in
      // one dir — the single-root model the install CLIs also use, mirroring
      // ~/.starkeep in production. Pass the full on-disk config so the boot write
      // preserves the install's apiGatewayUrl/auroraEndpoint rather than clobbering
      // them. No auth.json is seeded — sign-in happens via /auth/tokens next.
      lds = await startLocalDataServer({
        starkeepDir: paths.dataDir,
        config: { ...config } as Record<string, unknown>,
      });
      drive = await driveCreds(lds.url);
    });

    it("signs in through the LDS /auth/tokens handoff (real Cognito→STS exchange)", async () => {
      // The user-visible step 4 of cloud setup: the wizard POSTs the freshly
      // minted Cognito tokens to the daemon, which then performs the in-process
      // Identity-Pool (STS) exchange, persists cloud credentials, starts the
      // credential-refresh timer, and starts the sync supervisor. We drive that
      // real path here rather than pre-seeding auth.json, so the handoff —
      // Cognito sign-in → /auth/tokens → STS exchange → supervisor startup — has
      // end-to-end coverage against real AWS.
      const res = await fetch(`${lds!.url}/auth/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken: session.idToken,
          refreshToken: session.refreshToken,
        }),
      });
      expect(res.status).toBe(200);

      // The daemon now reports cloud config loaded and an authenticated session
      // backed by credentials it minted itself (not the test's out-of-band
      // signInAdmin exchange).
      const status = await fetch(`${lds!.url}/auth/status`);
      expect(status.status).toBe(200);
      const auth = (await status.json()) as {
        configLoaded: boolean;
        authenticated: boolean;
      };
      expect(auth.configLoaded).toBe(true);
      expect(auth.authenticated).toBe(true);
    });

    it("installs Drive in the cloud (User-Data-Owner identity)", async () => {
      // The cloud install mirrors the secret straight from the LDS's local
      // registry (no creds-file pre-seed): the CLI reads the same data.db the
      // supervisor signs from, since both share STARKEEP_DIR (the run-state dir).
      // So a passing /health below is itself the todo-39 regression — local
      // signer and cloud verifier agree because both derive from the one
      // registry secret.
      await runInstallCli("cli-install-drive", [], paths, session);
      const res = await cloudApp(drive).fetch("/health");
      expect(res.status).toBe(200);
    });

    it("installs photos in the cloud (bundle, Lambda, routes)", async () => {
      const manifest = JSON.parse(
        readFileSync(join(STARKEEP_APPS_DIR, "photos", "starkeep.manifest.json"), "utf-8"),
      ) as Record<string, unknown>;
      photos = await installAppDirect(lds!.url, manifest);
      await runInstallCli("cli-install-app", ["photos"], paths, session);

      const res = await cloudApp(photos).fetch("/health");
      expect(res.status).toBe(200);
    });

    it("syncs a photo to the cloud: record + blob under Drive, origin photos", async () => {
      const { record } = await createRecordWithBytes(photos, {
        bytes: photoBytes,
        fileName: "tier3.png",
      });
      syncedRecordId = record.id;

      // /sync/now requires app auth at the LDS gate (it's not a loopback-
      // exempt path), so drive it through an installed app's signed fetch.
      // `drive` here is the LdsApp from driveCreds — its dataServerUrl is the
      // local LDS, distinct from cloudApp(drive) which targets the broker.
      const sync = await drive.fetch("/sync/now", { method: "POST" });
      expect(sync.status).toBe(200);
      const { shipped } = (await sync.json()) as { applied: number; shipped: number };
      expect(shipped).toBeGreaterThan(0);

      const listRes = await cloudApp(drive).fetch("/data/records");
      expect(listRes.status).toBe(200);
      const { records } = (await listRes.json()) as {
        records: Array<{ id: string; originAppId?: string; origin_app_id?: string }>;
      };
      const synced = records.find((r) => r.id === syncedRecordId);
      expect(synced).toBeDefined();
      expect(synced!.originAppId ?? synced!.origin_app_id).toBe("photos");

      // Blob round-trip from S3 through the broker's presigned file-url.
      const urlRes = await cloudApp(drive).fetch(`/data/records/${syncedRecordId}/file-url`);
      expect(urlRes.status).toBe(200);
      const { url } = (await urlRes.json()) as { url: string };
      const blob = await fetch(url);
      expect(blob.status).toBe(200);
      expect(Buffer.from(await blob.arrayBuffer()).equals(photoBytes)).toBe(true);
    });

    it("reinstall after local creds drift: cloud install re-mirrors the registry secret, sync still validates", async () => {
      // Reproduce the todo-39 drift directly: leave a local creds file holding a
      // *different* secret than Drive's local registry (the value the supervisor
      // signs with). The pre-fix installer read this creds file and mirrored it
      // to SSM, so the cloud verifier ended up on a key no local signer held —
      // every signed Drive request then 401'd "Invalid signature".
      const credsDir = join(paths.dataDir, "app-creds");
      const driveCredsPath = join(credsDir, "starkeep-drive.json");
      mkdirSync(credsDir, { recursive: true, mode: 0o700 });
      writeFileSync(
        driveCredsPath,
        JSON.stringify(
          { appId: "starkeep-drive", hmacSecret: `${drive.hmacSecret}-drifted` },
          null,
          2,
        ),
        { mode: 0o600 },
      );

      // Re-run the cloud Drive install. The fix sources the secret from the
      // local registry (drive.hmacSecret), not the drifted creds file, and the
      // alwaysRun put_app_creds_parameter step re-mirrors it to SSM.
      await runInstallCli("cli-install-drive", [], paths, session);

      // The creds file is reconciled back to the registry secret (so
      // @starkeep/app-client and the app→LDS HMAC path also converge).
      const reconciled = JSON.parse(readFileSync(driveCredsPath, "utf-8")) as {
        hmacSecret: string;
      };
      expect(reconciled.hmacSecret).toBe(drive.hmacSecret);

      // Cloud verifier still agrees with the local signer (HMAC_CACHE_TTL_MS=0
      // in this suite, so the re-mirror takes effect immediately). Pre-fix this
      // 401'd because SSM held the drifted secret.
      const health = await cloudApp(drive).fetch("/health");
      expect(health.status).toBe(200);

      // And the sync exchange — signed by the supervisor with the registry
      // secret — still validates end-to-end.
      const sync = await drive.fetch("/sync/now", { method: "POST" });
      expect(sync.status).toBe(200);
      const statusRes = await drive.fetch("/sync/status");
      const { perApp } = (await statusRes.json()) as {
        perApp: Array<{ appId: string; lastError: string | null }>;
      };
      expect(perApp.find((e) => e.appId === "starkeep-drive")?.lastError).toBeNull();
    });

    it("photos cloud static handler serves", async () => {
      const res = await fetch(`${config.apiGatewayUrl}/apps/photos/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<");
    });

    it("photos resize endpoint round-trips", async () => {
      // Unlike the broker's HMAC-gated data/sync/app-data planes, an app's own
      // routes (e.g. photos /api/resize) sit behind the gateway's Cognito JWT
      // authorizer — they're user-facing, so they take the signed-in user's id
      // token as a Bearer credential, not an app HMAC signature.
      const res = await fetch(`${config.apiGatewayUrl}/apps/photos/api/resize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.idToken}`,
        },
        // The handler takes { targetId } and resizes to its own fixed max
        // width; there is no caller-supplied width.
        body: JSON.stringify({ targetId: syncedRecordId }),
      });
      expect(res.status).toBe(200);
    });

    it("writes a caption through the cloud /app-data plane", async () => {
      // App-specific tables live under /app-data/db/<table>; writes take a
      // { row } envelope whose keys are the manifest-declared columns
      // (image_enriched: record_id PK, caption).
      const insert = await cloudApp(photos).fetch("/app-data/db/image_enriched", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ row: { record_id: syncedRecordId, caption: "tier-3 caption" } }),
      });
      expect(insert.status).toBe(200);

      const query = await cloudApp(photos).fetch("/app-data/db/image_enriched");
      expect(query.status).toBe(200);
      const body = await query.text();
      expect(body).toContain("tier-3 caption");
    });

    it("uninstalls photos: app plane gone, shared records persist", async () => {
      await runInstallCli("cli-uninstall-app", ["photos"], paths, session);

      // App-plane access is gone (HMAC secret deleted → 401, or routes 404).
      const appGone = await cloudApp(photos).fetch("/health");
      expect([401, 403, 404]).toContain(appGone.status);

      // Shared records survive under Drive.
      const listRes = await cloudApp(drive).fetch("/data/records");
      expect(listRes.status).toBe(200);
      const { records } = (await listRes.json()) as { records: Array<{ id: string }> };
      expect(records.some((r) => r.id === syncedRecordId)).toBe(true);
    });
  },
);
