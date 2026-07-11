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

import { describe, it, expect, afterAll, afterEach } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chromium } from "@playwright/test";
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
import { cloudDataServerBundleSha256Base64 } from "@starkeep/admin-installer";
import {
  LambdaClient,
  GetFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import { AWS_TESTS_ENABLED, STACK_PREFIX, REGION, TEARDOWN } from "./env.js";
import { ensureBootstrapStack, type BootstrapOutputs } from "./bootstrap-stack.js";
import { ensureAdminUser } from "./admin-user.js";
import { signInAdmin, runInstallCli, type AdminSession } from "./installers.js";
import {
  runPaths,
  readConfig,
  writeConfig,
  type TestStackConfig,
  type AdminCredentials,
} from "./run-state.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STARKEEP_APPS_DIR = resolve(REPO_ROOT, "..", "starkeep-apps");

const paths = runPaths(STACK_PREFIX);

// Shared journey state, filled in step order.
let outputs: BootstrapOutputs;
let session: AdminSession;
let admin: AdminCredentials;
let config: TestStackConfig;
let lds: LocalDataServer | undefined;
let drive: LdsApp;
let photos: LdsApp;
let syncedRecordId: string;
// The photo the real browser uploads through the cloud-served UI: its bytes
// enter the cloud via browser→proxy→broker→S3, never touching the local data
// server. Captured here so the later cloud→local sync step can assert the
// record (and its exact bytes) apply down into the local registry.
let browserUploadName: string;
let browserUploadBytes: Buffer;
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

/**
 * Poll a CloudFront URL until it reports an edge hit, or give up. CloudFront
 * sets `x-cache: "Hit from cloudfront"` (also "RefreshHit ...") once the POP has
 * the object; the first fetch of a cacheable object populates it and a
 * subsequent fetch is a Hit. A second request can land on a sibling edge server
 * that hasn't cached yet, so we retry a few times before concluding. Returns the
 * last observed `x-cache` value.
 */
async function pollForEdgeHit(url: string, attempts = 8): Promise<string> {
  let last = "";
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url);
    // Drain the body so the connection is reusable and the fetch fully completes.
    await res.arrayBuffer();
    last = res.headers.get("x-cache") ?? "";
    if (/Hit from cloudfront/i.test(last)) return last;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return last;
}

/** Corrupt a CloudFront signature param into a still-well-formed but invalid one. */
function tamperSignature(sig: string): string {
  // CloudFront signatures use URL-safe base64 (chars incl. `-_~`). Swap the
  // first char for a different valid one so the value stays parseable but the
  // signature no longer verifies → CloudFront returns 403, not 400.
  const first = sig[0];
  const replacement = first === "A" ? "B" : "A";
  return replacement + sig.slice(1);
}

/** Retry a fetch until it stops returning a propagation-time 5xx, or give up. */
async function fetchWhenReady(url: string, attempts = 15): Promise<Response> {
  let res = await fetch(url);
  for (let i = 0; i < attempts && res.status >= 500; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    res = await fetch(url);
  }
  return res;
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
    // Teardown runs only on a fully green journey. A failed step leaves the
    // real cloud resources up so they can be inspected; the disposable stack is
    // idempotent, so the next run reuses (and eventually tears down) it. `bail:
    // 1` stops at the first failure, and this afterEach still fires for that
    // failing test, so `anyFailed` is set before afterAll decides.
    let anyFailed = false;
    afterEach((ctx) => {
      if (ctx.task.result?.state === "fail") anyFailed = true;
    });

    afterAll(async () => {
      await lds?.stop();
      if (anyFailed) {
        console.log(
          "[e2e-aws] journey failed — leaving cloud resources up for debugging " +
            `(tear down manually: scripts/teardown-bootstrap.sh --prefix ${STACK_PREFIX} --region ${REGION})`,
        );
        return;
      }
      if (TEARDOWN === "none") {
        console.log("[e2e-aws] STARKEEP_AWS_TEARDOWN=none — leaving cloud resources up");
        return;
      }
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
      admin = await ensureAdminUser(paths, outputs.userPoolId);
      session = await signInAdmin(config, admin);
      expect(session.idToken.split(".")).toHaveLength(3);
      expect(session.awsCredentials.accessKeyId).toBeTruthy();
    });

    it("installs cloud-data-server via the real CLI", async () => {
      // --ephemeral: these resources are torn down every run, so skip the
      // production data-protection hardening (versioning/SSE/public-access-block
      // + DSQL deletion protection) and let forceDestroy empty the bucket on
      // teardown. Real installs never pass this flag — see isEphemeralInstall.
      await runInstallCli("cli-install-cloud-data-server", ["--ephemeral"], paths, session);
      // The CLI rewrites config.json with apiGatewayUrl / s3Bucket / auroraEndpoint.
      config = readConfig(paths)!;
      expect(config.apiGatewayUrl).toMatch(/^https:\/\//);
      expect(config.auroraEndpoint).toBeTruthy();

      const health = await fetch(`${config.apiGatewayUrl}/health`);
      expect(health.status).toBe(200);

      // Defense in depth: a warm kept-up stack means the broker Lambda from a
      // prior run answers /health = 200 even if *this* run's redeploy silently
      // failed (e.g. Pulumi errored on a resource but the CLI exited 0). Prove
      // the live broker is running the bundle this checkout just built by
      // matching AWS's CodeSha256 against the deployed dist.zip's hash. This
      // passes on a legitimate no-change re-run (live code == built bundle) and
      // fails only when the running code is stale.
      // Read with the ambient operator credentials (the default provider
      // chain), NOT the admin-app session: the admin role is deliberately not a
      // superuser and has no standing lambda:GetFunctionConfiguration. This is a
      // test-side verification read of AWS state, so it mirrors how
      // ensureBootstrapStack's CloudFormation client runs on ambient creds.
      const lambda = new LambdaClient({ region: REGION });
      const fn = await lambda.send(
        new GetFunctionConfigurationCommand({
          FunctionName: `${STACK_PREFIX}-app-cloud-data-server-api`,
        }),
      );
      expect(fn.CodeSha256).toBe(cloudDataServerBundleSha256Base64());
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

    it("photos data plane works through the cloud-served /api/local-data proxy", async () => {
      // The seam that broke on cloud reinstall: the browser never signs; it
      // calls the app's OWN same-origin proxy (/api/local-data/...), served by
      // the cloud Next.js Lambda, which loads the photos HMAC secret from SSM
      // and forwards a *signed* request to the broker. The `static` handler is
      // public, so we can drive that proxy exactly as the browser does — no
      // Bearer token — and it must reach the HMAC-gated data plane.
      //
      // This is what listPhotos() does. Before the fix it hit the gateway
      // directly with only a Cognito token and got 401 "Missing X-Starkeep-App"
      // headers; and the manifest only routed GET to the proxy, so writes 404'd.
      const proxyBase = `${config.apiGatewayUrl}/apps/photos/api/local-data`;

      const listRes = await fetch(`${proxyBase}/data/records?limit=500`);
      expect(listRes.status).toBe(200);
      const { records } = (await listRes.json()) as { records: Array<{ id: string }> };
      expect(records.some((r) => r.id === syncedRecordId)).toBe(true);

      // A write verb through the proxy — guards the GET-only manifest regression
      // (the catch-all must be ANY, or every POST 404s at the gateway).
      const metaRes = await fetch(`${proxyBase}/data/records/${syncedRecordId}/metadata`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ typeId: "image", metadata: { width: 1, height: 1 } }),
      });
      expect(metaRes.status).toBe(200);
    });

    it("drives the real cloud Photos UI end-to-end: sign in, upload, see the photo", async () => {
      // True browser e2e of the cloud-served app: a real Chromium loads the SPA,
      // signs in through Cognito, and uploads a photo through the live file
      // input. That upload is the ENTIRE browser→proxy→broker write path —
      // presign → S3 PUT → POST /data/records → metadata POST — the exact flow
      // that was completely broken on reinstall (proxy bypassed → 401; GET-only
      // manifest → writes 404). Every layer the unit/contract tests stub is
      // exercised here for real, including S3 CORS on the presigned PUT, which
      // nothing else covers.
      //
      // Load via the CloudFront domain (publicBaseUrl), NOT the raw gateway.
      // Part A repoints the SPA's runtime API base to publicBaseUrl, so a real
      // browser makes its data calls to the CloudFront origin. Production
      // browsers reach the app via that same origin, keeping HTML + API
      // same-origin; loading the HTML from the gateway instead would split the
      // origin (gateway HTML, CloudFront API) and the app's same-origin fetches
      // would be CORS-blocked — a configuration that never occurs in the real
      // deployment. The raw-fetch steps above stay on apiGatewayUrl on purpose
      // (they assert the gateway is directly reachable, and Node fetch is not
      // CORS-bound); only the real browser needs the single CloudFront origin.
      const appUrl = `${config.publicBaseUrl}/apps/photos/`;

      // Fresh tiny PNG → new content hash (the kept-up cloud dedupes by hash).
      const uploadName = `e2e-browser-${Date.now()}.png`;
      const uploadBytes = solidPng([...randomBytes(3)] as [number, number, number], 12);
      browserUploadName = uploadName;
      browserUploadBytes = uploadBytes;
      const uploadDir = await mkdtemp(join(tmpdir(), "photos-cloud-ui-"));
      const uploadPath = join(uploadDir, uploadName);
      await writeFile(uploadPath, uploadBytes);

      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        await page.goto(appUrl, { waitUntil: "domcontentloaded" });

        // AuthGate (FORCE_REMOTE) gates the app behind Cognito sign-in. Drive
        // the real SignInForm with the permanent-password admin user; on
        // success the app reloads authenticated and the toolbar renders. In
        // this cloud journey the app runs FORCE_REMOTE (Cognito-gated), so the
        // upload control is labelled "Upload Photo" — it reads "Add Photo" only
        // in the local, non-remote build (see photos app.tsx).
        await page.locator('input[type="email"]').fill(admin.email);
        await page.locator('input[type="password"]').fill(admin.password);
        await page.getByRole("button", { name: "Sign in" }).click();
        await page
          .getByRole("button", { name: "Upload Photo" })
          .waitFor({ state: "visible", timeout: 120_000 });

        // Upload through the live file input and wait for the thumbnail to render.
        await page.locator('input[type="file"]').first().setInputFiles(uploadPath);
        await page
          .getByAltText(uploadName)
          .first()
          .waitFor({ state: "visible", timeout: 120_000 });

        // Cross-check the data plane: the shared record now exists in the cloud.
        const list = await cloudApp(photos).fetch("/data/records?limit=500");
        expect(list.status).toBe(200);
        const { records } = (await list.json()) as {
          records: Array<{ original_filename: string | null }>;
        };
        expect(records.some((r) => r.original_filename === uploadName)).toBe(true);
      } finally {
        await browser.close();
      }
    });

    it("cloud-origin browser upload syncs down to the local data server (record + bytes)", async () => {
      // The reverse direction of the earlier ship test. The browser upload above
      // landed in the cloud via browser→proxy→broker→S3 and never touched the
      // local data server, so it is a genuinely cloud-origin shared record. The
      // Drive supervisor must now pull it DOWN and apply it — record row and blob
      // bytes — into the local registry, which is what makes a photo taken/added
      // on one device show up on another. `/sync/now` runs a full exchange (it
      // applied cloud-pending in one call in the ship step), so a single pull
      // should land it; we still retry a few times to absorb any lag in the
      // broker surfacing the just-written record to the pull.
      expect(browserUploadName, "browser upload step must have run first").toBeTruthy();

      let localRecord: { id: string; original_filename?: string | null } | undefined;
      for (let attempt = 0; attempt < 5 && !localRecord; attempt++) {
        const sync = await drive.fetch("/sync/now", { method: "POST" });
        expect(sync.status).toBe(200);
        const local = await photos.fetch("/data/records?limit=500&include=metadata");
        expect(local.status).toBe(200);
        const { records } = (await local.json()) as {
          records: Array<{ id: string; original_filename?: string | null }>;
        };
        localRecord = records.find((r) => r.original_filename === browserUploadName);
      }
      expect(
        localRecord,
        "browser-uploaded photo must sync down to the local data server",
      ).toBeDefined();

      // The bytes came down too: the local file-url serves the exact PNG the
      // browser uploaded (mirrors the cloud-side byte round-trip in the ship
      // test, but proving the cloud→local blob transfer instead).
      const urlRes = await photos.fetch(`/data/records/${localRecord!.id}/file-url`);
      expect(urlRes.status).toBe(200);
      const { url } = (await urlRes.json()) as { url: string };
      const blob = await fetch(url);
      expect(blob.status).toBe(200);
      expect(Buffer.from(await blob.arrayBuffer()).equals(browserUploadBytes)).toBe(true);
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

    it("Part A: SPA + _next/static served through the CloudFront distribution (edge hit)", async () => {
      // The whole point of Part A: browser-facing traffic goes to the CloudFront
      // domain (publicBaseUrl), not the raw gateway. Every other step in this
      // journey deliberately hits apiGatewayUrl directly (the gateway stays
      // reachable — CloudFront is an optimization layer, not a security
      // boundary), so this is the ONLY coverage of the distribution itself.
      // Placed late so the distribution — created minutes ago during the
      // cloud-data-server install — has had time to reach "Deployed".
      const base = config.publicBaseUrl;
      expect(base, "cloud-data-server install must persist publicBaseUrl").toBeTruthy();
      expect(base!).toMatch(/^https:\/\/[a-z0-9]+\.cloudfront\.net$/);

      // SPA entry point via CloudFront → gateway origin (default no-cache
      // behavior; AllViewerExceptHostHeader forwards viewer headers, strips
      // Host so the HTTP API accepts it). Retry through any propagation 5xx.
      const spa = await fetchWhenReady(`${base}/apps/photos/`);
      expect(spa.status).toBe(200);
      const html = await spa.text();
      expect(html).toContain("<");
      expect((spa.headers.get("via") ?? "").toLowerCase()).toContain("cloudfront");

      // A content-hashed Next asset the SPA references → the /apps/*/_next/static/*
      // behavior (CachingOptimized). These are immutable, so the edge caches
      // them: after a priming fetch a later fetch reports `x-cache: Hit`.
      const match = html.match(/\/apps\/photos\/_next\/static\/[^"'\\]+/);
      expect(match, "SPA HTML should reference a _next/static asset").toBeTruthy();
      const assetUrl = `${base}${match![0]}`;

      const asset = await fetchWhenReady(assetUrl);
      expect(asset.status).toBe(200);
      const xCache = await pollForEdgeHit(assetUrl);
      expect(xCache, `no edge hit for ${assetUrl} (last x-cache: ${xCache})`).toMatch(
        /Hit from cloudfront/i,
      );
    });

    it("Part B: shared bytes via CloudFront signed URL — edge hit, tamper rejected, apps/* isolated", async () => {
      const base = config.publicBaseUrl!;

      // The shared file-url endpoint now mints a CloudFront signed URL on the
      // distribution (was an S3 presigned URL). Same auth checks, new minting.
      const urlRes = await cloudApp(drive).fetch(`/data/records/${syncedRecordId}/file-url`);
      expect(urlRes.status).toBe(200);
      const { url } = (await urlRes.json()) as { url: string };
      const signed = new URL(url);
      expect(signed.host).toBe(new URL(base).host); // distribution domain, not S3
      expect(signed.pathname.startsWith("/shared/")).toBe(true);
      const signature = signed.searchParams.get("Signature");
      expect(signature).toBeTruthy();
      expect(signed.searchParams.get("Key-Pair-Id")).toBeTruthy();

      // Bytes round-trip through the edge and match what was uploaded.
      const first = await fetchWhenReady(url);
      expect(first.status).toBe(200);
      expect(Buffer.from(await first.arrayBuffer()).equals(photoBytes)).toBe(true);

      // Edge hit on re-fetch. The custom cache policy excludes query strings from
      // the cache key (the signed-URL params are validated then dropped), so a
      // freshly signed URL for the same path still hits the path-keyed cache —
      // this is exactly what makes Part B deliver anything.
      const xCache = await pollForEdgeHit(url);
      expect(xCache, `no edge hit for shared object (last x-cache: ${xCache})`).toMatch(
        /Hit from cloudfront/i,
      );

      // Tampered signature → 403: CloudFront enforces the key-group signature.
      const tampered = new URL(url);
      tampered.searchParams.set("Signature", tamperSignature(signature!));
      const bad = await fetch(tampered.toString());
      expect(bad.status).toBe(403);

      // No signature on the shared/* behavior → 403 (Missing Key): the S3 origin
      // is signature-gated, never openly readable through the distribution.
      const unsigned = await fetch(`${base}${signed.pathname}`);
      expect(unsigned.status).toBe(403);

      // apps/* is unreachable through the S3 files origin: the distribution has
      // NO apps/*→S3 behavior (only shared/* routes to the bucket, and the
      // bucket policy's OAC Allow is scoped to shared/*). So an apps/* path
      // routes to the GATEWAY origin (default/SPA behavior) and can never serve
      // app-private S3 bytes. Prove it lands on the gateway (HTML/SPA), not S3.
      const appsProbe = await fetch(
        `${base}/apps/photos/syncable/does-not-exist-${Date.now()}.bin`,
      );
      const probeBody = await appsProbe.text();
      expect(probeBody).toContain("<"); // gateway/SPA HTML, not an S3 object
      expect((appsProbe.headers.get("content-type") ?? "").toLowerCase()).not.toContain(
        "octet-stream",
      );
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
