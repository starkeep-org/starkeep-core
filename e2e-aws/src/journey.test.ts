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
const photoBytes = solidPng([0, 128, 255]);

/** HMAC-signed fetch against the real broker: `${apiGatewayUrl}/apps/{appId}`. */
function cloudApp(local: AppCredentials): LdsApp {
  const creds: AppCredentials = {
    appId: local.appId,
    hmacSecret: local.hmacSecret,
    dataServerUrl: `${config.apiGatewayUrl}/apps/${encodeURIComponent(local.appId)}`,
  };
  return { ...creds, fetch: (path, init) => signedFetch(creds, path, init) };
}

/**
 * Mirror an LDS-held app secret into the run dir's app-creds file, where the
 * cloud install CLI (`ensureLocalHmacSecret`) reads it before writing SSM.
 * This is how the local signer and the cloud verifier end up sharing a key.
 */
function mirrorLocalCreds(app: AppCredentials): void {
  const credsDir = join(paths.dataDir, "app-creds");
  mkdirSync(credsDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(credsDir, `${app.appId}.json`),
    JSON.stringify({ appId: app.appId, hmacSecret: app.hmacSecret }, null, 2),
    { mode: 0o600 },
  );
}

function runTeardownScript(script: string): void {
  const result = spawnSync(
    "bash",
    [join(REPO_ROOT, "scripts", script), "--yes", "--prefix", STACK_PREFIX, "--region", REGION],
    {
      stdio: "inherit",
      env: { ...process.env, STARKEEP_DATA_DIR: paths.dataDir, AWS_REGION: REGION },
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
      lds = await startLocalDataServer({
        config: { apiGatewayUrl: config.apiGatewayUrl },
        auth: { idToken: session.idToken },
      });
      drive = await driveCreds(lds.url);
      mirrorLocalCreds(drive);
    });

    it("installs Drive in the cloud (User-Data-Owner identity)", async () => {
      await runInstallCli("cli-install-drive", [], paths, session);
      // Cloud verifier and local signer must now agree on Drive's key.
      const res = await cloudApp(drive).fetch("/health");
      expect(res.status).toBe(200);
    });

    it("installs photos in the cloud (bundle, Lambda, routes)", async () => {
      const manifest = JSON.parse(
        readFileSync(join(STARKEEP_APPS_DIR, "photos", "starkeep.manifest.json"), "utf-8"),
      ) as Record<string, unknown>;
      photos = await installAppDirect(lds!.url, manifest);
      mirrorLocalCreds(photos);
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

      const sync = await fetch(`${lds!.url}/sync/now`, { method: "POST" });
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

    it("photos cloud static handler serves", async () => {
      const res = await fetch(`${config.apiGatewayUrl}/apps/photos/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<");
    });

    it("photos resize endpoint round-trips", async () => {
      const res = await cloudApp(photos).fetch("/api/resize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordId: syncedRecordId, width: 4 }),
      });
      expect(res.status).toBe(200);
    });

    it("writes a caption through the cloud /app-data plane", async () => {
      const insert = await cloudApp(photos).fetch("/app-data/image_enriched", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ record_id: syncedRecordId, caption: "tier-3 caption" }),
      });
      expect(insert.status).toBe(200);

      const query = await cloudApp(photos).fetch("/app-data/image_enriched");
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
