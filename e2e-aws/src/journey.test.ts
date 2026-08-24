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

import { describe, it, expect, afterAll, afterEach, beforeAll } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
  eventually,
  solidPng,
  type LdsApp,
} from "@starkeep/e2e";
import { signedFetch, USER_TOKEN_HEADER, type AppCredentials } from "@starkeep/app-client";
import {
  cloudDataServerBundleSha256Base64,
  createDsqlRegistry,
} from "@starkeep/admin-installer";
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
  resetLocalNodeState,
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

/**
 * HMAC-signed fetch against the real broker: `${apiGatewayUrl}/apps/{appId}`.
 *
 * The HMAC alone is no longer enough, and that is the point of the change it
 * reflects: the broker requires a credential bound to a named end user on every
 * data-plane call, with no route carve-out and nothing an app can declare to opt
 * out. Standing in for an app's server-side compute, this helper presents what
 * that compute presents — the signature saying which app is calling, and the
 * admin's ID token saying which person it is calling for.
 *
 * Read from `session` at call time rather than captured, because the token is
 * minted in step 2 and this helper is defined before it.
 */
function cloudApp(local: AppCredentials): LdsApp {
  const creds: AppCredentials = {
    appId: local.appId,
    hmacSecret: local.hmacSecret,
    dataServerUrl: `${config.apiGatewayUrl}/apps/${encodeURIComponent(local.appId)}`,
  };
  return {
    ...creds,
    fetch: (path, init) =>
      signedFetch(creds, path, {
        ...init,
        headers: { ...(init?.headers ?? {}), [USER_TOKEN_HEADER]: session.idToken },
      }),
  };
}

/**
 * Sign in through an app's own session route and return the `Cookie` header a
 * browser would send afterwards.
 *
 * This is deliberately the same round trip the browser makes: a POST to the
 * app's `/api/session/sign-in`, which runs the Cognito flow server-side and
 * hands back `sk_session` (the refresh token) and `sk_token` (a minted ID
 * token) as HttpOnly cookies. The suite holds neither credential itself, which
 * is the property under test — the page cannot read them either.
 *
 * `/api/session/*` is a declared public path, so this request needs no prior
 * authentication; everything the session gates is reached with what it returns.
 */
async function signInToApp(appId: string): Promise<string> {
  const res = await fetch(
    `${config.apiGatewayUrl}/apps/${encodeURIComponent(appId)}/api/session/sign-in`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: admin.email, password: admin.password }),
    },
  );
  const body = await res.text();
  expect(res.status, `sign-in to ${appId} answered ${res.status}: ${body}`).toBe(200);

  const cookies = res.headers.getSetCookie();
  const jar = cookiesToHeader(cookies);
  expect(jar, `sign-in to ${appId} set no session cookie: ${cookies.join(" | ")}`).toContain(
    "sk_session=",
  );
  expect(jar).toContain("sk_token=");
  return jar;
}

/** `Set-Cookie` response headers → the `Cookie` request header they produce. */
function cookiesToHeader(setCookies: string[]): string {
  return setCookies
    .map((c) => c.split(";")[0]!.trim())
    .filter((pair) => pair.includes("="))
    .join("; ");
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
async function fetchWhenReady(
  url: string,
  init?: RequestInit,
  attempts = 15,
): Promise<Response> {
  let res = await fetch(url, init);
  for (let i = 0; i < attempts && res.status >= 500; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    res = await fetch(url, init);
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

    // The run dir persists between runs so a kept-up cloud stack can be reused
    // (config.json) and its admin user re-signed-in (admin.json) — but the
    // LOCAL node state in that same dir must be fresh every run, or the last
    // run's registry and auth leak into this one. See resetLocalNodeState for
    // the two failure modes this prevents (stale schema; stale auth.json
    // starting sync before the /auth/tokens handoff does).
    beforeAll(() => {
      resetLocalNodeState(paths);
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
      //
      // Assert that precondition rather than assume it. This comment has always
      // claimed "no auth.json", but nothing checked, and the LDS *writes* that
      // file itself on a successful handoff — so a prior run left one behind and
      // the daemon booted already authenticated, starting sync before the
      // handoff and making the later `shipped > 0` pass for the wrong reason.
      // resetLocalNodeState clears it; this is the guard that keeps it true.
      expect(
        existsSync(join(paths.dataDir, "auth.json")),
        "boot must be unauthenticated — the /auth/tokens handoff is what starts sync",
      ).toBe(false);

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
      //
      // Driven in a converge loop, and asserted on the record reaching the
      // cloud rather than on a single round's `shipped` count. Creating a
      // record nudges a background exchange on a 50 ms debounce, so an
      // explicit `/sync/now` can truthfully report "shipped 0" for a record
      // that the background round already carried up — that count answers
      // which round got there first, not whether sync worked. (The LDS unit
      // suite hit the same race; see sync-over-wire.test.ts.)
      const cloudDrive = cloudApp(drive);
      let synced: { id: string; originAppId?: string; origin_app_id?: string };
      try {
        synced = await eventually(async () => {
          const sync = await drive.fetch("/sync/now", { method: "POST" });
          expect(sync.status).toBe(200);

          const listRes = await cloudDrive.fetch("/data/records");
          expect(listRes.status).toBe(200);
          const { records } = (await listRes.json()) as {
            records: Array<{ id: string; originAppId?: string; origin_app_id?: string }>;
          };
          const found = records.find((r) => r.id === syncedRecordId);
          if (!found) throw new Error(`record ${syncedRecordId} has not reached the cloud yet`);
          return found;
        });
      } catch (err) {
        // The supervisor swallows per-engine exchange failures into a logged
        // `lastError` and still returns 200 with shipped: 0, so the HTTP
        // response cannot distinguish "nothing to ship" from "every round
        // threw". Without these lines a sync failure here presents only as a
        // count that didn't move, which is what makes it hard to diagnose.
        const syncLines = (lds?.logs() ?? "")
          .split("\n")
          .filter((l) => /\[sync|sync\]|exchange|drive/i.test(l));
        console.error(
          `[e2e-aws] sync did not reach the cloud. LDS sync log:\n${
            syncLines.length > 0 ? syncLines.join("\n") : "(no sync lines logged)"
          }`,
        );
        throw err;
      }
      expect(synced.originAppId ?? synced.origin_app_id).toBe("photos");

      // Blob round-trip from S3 through the broker's presigned file-url.
      const urlRes = await cloudApp(drive).fetch(`/data/records/${syncedRecordId}/file-url`);
      expect(urlRes.status).toBe(200);
      const { url } = (await urlRes.json()) as { url: string };
      const blob = await fetch(url);
      expect(blob.status).toBe(200);
      expect(Buffer.from(await blob.arrayBuffer()).equals(photoBytes)).toBe(true);
    });

    it("cross-app labels round-trip against real DSQL: write, hydrate, reverse query, retract", async () => {
      // The only place the shipped label code meets a real DSQL cluster. The
      // POC that settled the index shape ran hand-written SQL; everything else
      // in CI runs against SQLite or a scripted fake, so three things are
      // untested until here: that DSQL accepts the reverse index at all, that
      // `value asc nulls first` is valid where SQLite needs no spelling, and
      // that a multi-row ON CONFLICT DO UPDATE commits.
      const cloudPhotos = cloudApp(photos);

      // Two labels in one batch — one flag, one valued — on the record that
      // synced up above.
      //
      // Both are keys Photos actually declares in its manifest, which is load
      // bearing rather than cosmetic: the broker rejects an undeclared key with
      // a 400, so an inert test string would fail here and not at the thing
      // this step is testing. (`photos/thumbnail` used to be the flag; the
      // rendition respec replaced it with a valued `photos/rendition`, and this
      // step kept writing the old name until it 400'd against a real cluster.)
      //
      // `crop` is the flag. `faces` is the valued one, seeked by value below —
      // which is its real use: `?label=photos/faces&labelValue=Alice`.
      // Deliberately not `rendition`: setting `rendition=image-thumb` on this
      // record would make the app read the original as its own thumbnail, and
      // the later resize step would correctly refuse it.
      const write = await cloudPhotos.fetch("/data/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          labels: [
            { recordId: syncedRecordId, key: "crop" },
            { recordId: syncedRecordId, key: "faces", value: "e2e" },
          ],
        }),
      });
      expect(write.status).toBe(200);
      expect((await write.json()) as { written: number }).toEqual({ written: 2 });

      // The registry is readable cross-app — the reason keys are declared in a
      // manifest rather than counted at runtime.
      const keysRes = await cloudApp(drive).fetch("/data/label-keys?app=photos");
      expect(keysRes.status).toBe(200);
      const { labelKeys } = (await keysRes.json()) as { labelKeys: Array<{ label: string }> };
      expect(labelKeys.map((k) => k.label)).toEqual(
        expect.arrayContaining(["photos/crop", "photos/faces"]),
      );

      // Hydration: Drive holds no per-type grants but sees every app's labels
      // on a record it can read.
      const hydrated = await cloudApp(drive).fetch("/data/records?include=labels&limit=1000");
      const { records } = (await hydrated.json()) as {
        records: Array<{ id: string; labels?: Array<{ label: string; value: string | null }> }>;
      };
      const labelled = records.find((r) => r.id === syncedRecordId);
      expect(labelled?.labels?.map((l) => l.label).sort()).toEqual([
        "photos/crop",
        "photos/faces",
      ]);

      // The reverse query — the thing labels exist for, and the query the
      // measured index shape was chosen for. Presence first.
      const presence = await cloudApp(drive).fetch(
        "/data/records?label=photos/crop&limit=1000",
      );
      expect(presence.status).toBe(200);
      const presenceBody = (await presence.json()) as {
        records: Array<{ id: string }>;
        nextCursor: string | null;
      };
      expect(presenceBody.records.map((r) => r.id)).toContain(syncedRecordId);

      // Then the exact-value seek, which is why `value` is in the index key.
      const byValue = await cloudApp(drive).fetch(
        "/data/records?label=photos/faces&labelValue=e2e&limit=1000",
      );
      const matched = (await byValue.json()) as { records: Array<{ id: string }> };
      expect(matched.records.map((r) => r.id)).toContain(syncedRecordId);

      const byWrongValue = await cloudApp(drive).fetch(
        "/data/records?label=photos/faces&labelValue=nope&limit=1000",
      );
      const unmatched = (await byWrongValue.json()) as { records: Array<{ id: string }> };
      expect(unmatched.records.map((r) => r.id)).not.toContain(syncedRecordId);

      // Retraction is a tombstone, and `deleted_at` being a key column of the
      // reverse index is what keeps tombstones out of the scanned range.
      const retract = await cloudPhotos.fetch("/data/labels/retract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labels: [{ recordId: syncedRecordId, key: "faces" }] }),
      });
      expect(retract.status).toBe(200);

      const afterRetract = await cloudApp(drive).fetch(
        "/data/records?label=photos/faces&limit=1000",
      );
      const remaining = (await afterRetract.json()) as { records: Array<{ id: string }> };
      expect(remaining.records.map((r) => r.id)).not.toContain(syncedRecordId);

      // ...and the flag on the same record is untouched by it.
      const stillFlagged = await cloudApp(drive).fetch(
        "/data/records?label=photos/crop&limit=1000",
      );
      const flagged = (await stillFlagged.json()) as { records: Array<{ id: string }> };
      expect(flagged.records.map((r) => r.id)).toContain(syncedRecordId);

      // Now put the record back the way this step found it: later steps read
      // this same record, and a label left on it is state leaking across steps.
      // Retracting the flag also covers the valueless retract path, which the
      // `faces` retraction above does not.
      const retractFlag = await cloudPhotos.fetch("/data/labels/retract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labels: [{ recordId: syncedRecordId, key: "crop" }] }),
      });
      expect(retractFlag.status).toBe(200);

      const afterFlagRetract = await cloudApp(drive).fetch(
        "/data/records?label=photos/crop&limit=1000",
      );
      const unflagged = (await afterFlagRetract.json()) as { records: Array<{ id: string }> };
      expect(unflagged.records.map((r) => r.id)).not.toContain(syncedRecordId);
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
      // The app root, spelled the way the platform can actually register it.
      // `/` is declared public and becomes `ANY /apps/photos`; the manifest's
      // reach is real here rather than aspirational.
      const res = await fetch(`${config.apiGatewayUrl}/apps/photos`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<");
    });

    it("the app root's trailing-slash spelling is gated, and that is a platform limit", async () => {
      // Asserted rather than left as a surprise. API Gateway v2 refuses a route
      // key with an empty path segment, so `ANY /apps/photos/` cannot exist
      // beside `ANY /apps/photos` — the same limit that makes the manifest's
      // `GET /` collapse to the bare prefix. The trailing-slash spelling
      // therefore falls to the gated catch-all.
      //
      // It fails closed, which is why it is acceptable: an anonymous caller
      // gets 401 rather than the shell. Through CloudFront, which is how the
      // app is actually reached, a browser navigation to either spelling is
      // redirected to sign-in and a signed-in one is let through — so no user
      // meets this. It is pinned here so that if the routing ever changes, the
      // change is deliberate and visible rather than silent.
      const withSlash = await fetch(`${config.apiGatewayUrl}/apps/photos/`);
      expect(withSlash.status).toBe(401);
    });

    it("photos data plane works through the cloud-served /api/local-data proxy", async () => {
      // The seam that broke on cloud reinstall: the browser never signs; it
      // calls the app's OWN same-origin proxy (/api/local-data/...), served by
      // the cloud Next.js Lambda, which loads the photos HMAC secret from SSM
      // and forwards a *signed* request to the broker.
      //
      // This is what listPhotos() does. Before the fix it hit the gateway
      // directly with only a Cognito token and got 401 "Missing X-Starkeep-App"
      // headers; and the manifest only routed GET to the proxy, so writes 404'd.
      //
      // The requests below carry a session cookie because that is now the only
      // way through: the gateway's session authorizer refuses the catch-all,
      // and the proxy refuses a caller it has not authenticated. Until the
      // session layer landed these same calls succeeded with no credential of
      // any kind, which was the exposure — the negative test immediately after
      // this one is what holds that closed.
      const cookie = await signInToApp("photos");
      const proxyBase = `${config.apiGatewayUrl}/apps/photos/api/local-data`;

      const listRes = await fetch(`${proxyBase}/data/records?limit=500`, {
        headers: { cookie },
      });
      expect(listRes.status).toBe(200);
      const { records } = (await listRes.json()) as { records: Array<{ id: string }> };
      expect(records.some((r) => r.id === syncedRecordId)).toBe(true);

      // A write verb through the proxy — guards the GET-only manifest regression
      // (the catch-all must be ANY, or every POST 404s at the gateway).
      const metaRes = await fetch(`${proxyBase}/data/records/${syncedRecordId}/metadata`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ typeId: "image", metadata: { width: 1, height: 1 } }),
      });
      expect(metaRes.status).toBe(200);
    });

    it("refuses an unauthenticated caller on every app data path", async () => {
      // The negative case. Every other request this suite makes is
      // authenticated, and a suite that always signs in can never observe that
      // authentication is optional — which is precisely how the exposure went
      // unnoticed for three months (postmortem 2026-08-23, §4).
      //
      // This asserts the property the platform actually needs: an anonymous
      // caller who knows the URL gets nothing. It needs no knowledge of why an
      // exposure exists or where the check belongs; if any future app ships a
      // reachable data path with no server-side end-user check, this fails.
      //
      // It names no app. The list comes from the cloud registry — the same
      // rows the installer writes — so an app installed by a future step of
      // this journey, or by a future version of the platform, is covered the
      // day it is installed rather than the day someone remembers to add it
      // here. Naming Photos is what a check like this must not do: the
      // exposure propagated to Memo precisely because the second app was never
      // re-examined.
      const registry = createDsqlRegistry({
        hostname: config.auroraEndpoint!,
        region: REGION,
        stackPrefix: STACK_PREFIX,
        credentials: session.awsCredentials,
      });
      let installed: Awaited<ReturnType<typeof registry.listInstalledApps>>;
      try {
        installed = await registry.listInstalledApps();
      } finally {
        await registry.close();
      }
      expect(installed.length, "the cloud registry lists no installed apps").toBeGreaterThan(0);

      // Two mounts per app, and they fail for different reasons if they fail.
      //
      //   /{data,app-data,files,sync}/*  — the broker's own routes. Refusal
      //     here is the HMAC gate plus the end-user gate the broker applies to
      //     every data-plane call.
      //   /api/local-data/*             — the convention for an app's own
      //     signing proxy, the mount that was open in August. Under
      //     `auth: "session"` an undeclared path is refused at the gateway
      //     before the app's bundle is reached, so an app that has no such
      //     route refuses it for that reason instead; either way the answer an
      //     anonymous caller gets is nothing.
      // The two mounts differ in what "nothing" is allowed to look like, and
      // the difference is not cosmetic.
      //
      // The broker's routes exist for every installed app, so a refusal there
      // has to be a refusal: a 404 would mean the reserved data plane had
      // stopped being routed, which is a fault worth failing on.
      //
      // The proxy mount is a convention, not a guarantee. An app with no
      // compute — Starkeep Drive — has no such route for the gateway to reach,
      // so it answers 404. That is the same outcome for the caller (nothing)
      // arrived at one step earlier, and refusing to accept it would force
      // every app to own a route it does not want in order to reject callers
      // on it.
      const REFUSED = [401, 403];
      const REFUSED_OR_ABSENT = [401, 403, 404];
      const mounts = [
        { label: "shared records (list)", path: "/data/records?limit=1", allow: REFUSED },
        { label: "app-data rows", path: "/app-data/db/probe", allow: REFUSED },
        { label: "file bytes", path: "/files/probe", allow: REFUSED },
        { label: "sync exchange", path: "/sync/exchange", allow: REFUSED },
        {
          label: "proxy: shared records (list)",
          path: "/api/local-data/data/records?limit=1",
          allow: REFUSED_OR_ABSENT,
        },
        {
          label: "proxy: app-data rows",
          path: "/api/local-data/app-data/db/probe",
          allow: REFUSED_OR_ABSENT,
        },
      ];

      const probes: Array<{ label: string; url: string; allow: number[]; init?: RequestInit }> = [];
      for (const app of installed) {
        const appBase = `${config.apiGatewayUrl}/apps/${encodeURIComponent(app.appId)}`;
        for (const mount of mounts) {
          probes.push({
            label: `${app.appId} ${mount.label}`,
            url: `${appBase}${mount.path}`,
            allow: mount.allow,
          });
        }
        // A write verb too: a mount that refuses reads and accepts writes is
        // still an exposure, and the catch-all must be ANY for the write to
        // reach the app at all.
        probes.push({
          label: `${app.appId} proxy: shared records (write)`,
          url: `${appBase}/api/local-data/data/records/${syncedRecordId}/metadata`,
          allow: REFUSED_OR_ABSENT,
          init: {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ typeId: "image", metadata: { width: 1, height: 1 } }),
          },
        });
      }

      // No Authorization header, no cookie, no prior state — exactly what an
      // anonymous client on the internet can send. Every probe runs before any
      // assertion so a failure report names the whole anonymous surface rather
      // than only the first path that answered.
      const statuses: number[] = [];
      for (const probe of probes) {
        const res = await fetch(probe.url, probe.init);
        statuses.push(res.status);
      }
      const summary = probes.map((p, i) => `${p.label}: ${statuses[i]}`).join("; ");

      for (const [i, probe] of probes.entries()) {
        expect(
          probe.allow,
          `${probe.label} answered an unauthenticated caller with ${statuses[i]}. ` +
            `An app's data path must refuse a caller it has not authenticated: the ` +
            `cloud data plane identifies the APP, not the end user, so if the app does ` +
            `not check, nothing does. All probes: ${summary}`,
        ).toContain(statuses[i]!);
      }

      // Whatever else is true, no probe may have been *answered*. Stated
      // separately because the per-mount lists above are the place a future
      // edit would widen, and widening one of them to admit a 200 should not
      // be something a single careless line can do.
      for (const [i, probe] of probes.entries()) {
        expect(statuses[i], `${probe.label} served an anonymous caller`).not.toBe(200);
      }
    });

    it("a valid app signature is not enough: the broker demands an end user too", async () => {
      // The counterpart to `cloudApp` attaching a token. Everything the broker
      // needs to know which *app* is calling is present and correct here — a
      // live HMAC secret, a fresh signature over the real path and body — and
      // the answer is still 401, because nothing says which *person* the app is
      // acting for.
      //
      // This is the assertion that keeps the positive path honest. Without it,
      // a future change that dropped the end-user requirement would leave every
      // other step in this suite green: they all carry a token, so none of them
      // can observe that carrying one is required.
      const signedNoUser = await signedFetch(
        {
          appId: photos.appId,
          hmacSecret: photos.hmacSecret,
          dataServerUrl: `${config.apiGatewayUrl}/apps/${encodeURIComponent(photos.appId)}`,
        },
        "/data/records?limit=1",
      );
      expect(signedNoUser.status).toBe(401);
      expect(await signedNoUser.text()).toContain("X-Starkeep-User-Token");

      // And a token that is not a token does not satisfy it either — the gate
      // verifies against the pool's JWKS rather than checking the header is
      // present.
      const garbageToken = await signedFetch(
        {
          appId: photos.appId,
          hmacSecret: photos.hmacSecret,
          dataServerUrl: `${config.apiGatewayUrl}/apps/${encodeURIComponent(photos.appId)}`,
        },
        "/data/records?limit=1",
        { headers: { [USER_TOKEN_HEADER]: "not.a.token" } },
      );
      expect(garbageToken.status).toBe(401);
    });

    it("a session cookie is the whole difference between served and refused", async () => {
      // The positive and negative steps above each hold one end of this, but
      // neither one watches the same URL change its answer. This does: one
      // path, three requests, and the only thing that varies is whether the
      // caller holds a session.
      //
      // Refusal has two spellings here and both are correct, because they say
      // different things about where the request died:
      //
      //   401 — no `Cookie` header at all. That is the authorizer's declared
      //         identity source, and API Gateway short-circuits a request that
      //         omits it without ever invoking the authorizer.
      //   403 — a `Cookie` header arrived and the authorizer denied it. The
      //         signed-out case lands here rather than on 401: clearing a
      //         cookie sets it empty rather than removing the header, so the
      //         request still carries an identity source, and it is the
      //         authorizer that refuses it.
      //
      // Asserted as "refused" rather than pinned to one code, since which of
      // the two applies is a property of how the caller cleared its state, not
      // of whether the platform let it in.
      const REFUSED = [401, 403];
      const url = `${config.apiGatewayUrl}/apps/photos/api/local-data/data/records?limit=1`;

      const anonymous = await fetch(url);
      expect(REFUSED).toContain(anonymous.status);

      const cookie = await signInToApp("photos");
      const authenticated = await fetch(url, { headers: { cookie } });
      expect(authenticated.status).toBe(200);

      // Sign-out clears the browser's copy of both cookies. It does not revoke
      // the refresh token — that is AdminUserGlobalSignOut, an operator action
      // rather than something a page can trigger — so what is asserted here is
      // what sign-out actually promises: the browser is told to drop them, and
      // a request carrying what is left is refused.
      const out = await fetch(`${config.apiGatewayUrl}/apps/photos/api/session/sign-out`, {
        method: "POST",
        headers: { cookie },
      });
      expect(out.status).toBe(200);
      const cleared = out.headers.getSetCookie();
      expect(cleared.filter((c) => /^sk_(session|token)=;/.test(c))).toHaveLength(2);
      for (const c of cleared) expect(c).toContain("Max-Age=0");

      const afterSignOut = await fetch(url, { headers: { cookie: cookiesToHeader(cleared) } });
      expect(REFUSED).toContain(afterSignOut.status);
      expect(afterSignOut.status, "a signed-out caller was served").not.toBe(200);
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
      // Declared out here so the catch below can reach it; filled in as soon as
      // the page exists.
      let problemReport: () => string = () => "";
      try {
        const page = await browser.newPage();

        // A browser failure in a cloud journey is the hardest kind to diagnose
        // after the fact: the page is gone, the stack may be torn down, and all
        // that survives is a locator timeout. Collect what the browser saw so a
        // failure below can say it out loud.
        const pageProblems: string[] = [];
        page.on("console", (m) => {
          if (m.type() === "error") pageProblems.push(`console: ${m.text().slice(0, 200)}`);
        });
        page.on("pageerror", (e) => pageProblems.push(`pageerror: ${String(e).slice(0, 200)}`));
        page.on("requestfailed", (r) =>
          pageProblems.push(`requestfailed: ${r.failure()?.errorText ?? "?"} ${r.url().slice(0, 120)}`),
        );
        page.on("response", (r) => {
          if (r.status() >= 400) pageProblems.push(`${r.status()} ${r.url().slice(0, 120)}`);
        });
        problemReport = (): string =>
          pageProblems.length
            ? `\nWhat the browser saw:\n  ${[...new Set(pageProblems)].join("\n  ")}`
            : "\nThe browser reported no console errors and no failed requests.";

        // `load`, not `domcontentloaded`. The sign-in form is server-rendered,
        // so its fields exist in the initial HTML and can be filled before
        // React has hydrated — and that desync is permanent, not a race that
        // settles: React attaches with its own empty state, the DOM keeps the
        // typed text, and the submit button stays disabled forever because it
        // enables on state. Re-filling does not recover it. Measured against
        // this deployment, `load` and `networkidle` both hydrate reliably
        // before the first fill and `domcontentloaded` reliably does not.
        await page.goto(appUrl, { waitUntil: "load" });

        // The gateway sends a signed-out document request to the app's own
        // sign-in page, so this lands on /sign-in and drives the real form with
        // the permanent-password admin user. On success the app reloads
        // authenticated and the toolbar renders. In this cloud journey the app
        // runs FORCE_REMOTE (Cognito-gated), so the upload control is labelled
        // "Upload Photo" — it reads "Add Photo" only in the local, non-remote
        // build (see photos app.tsx).
        //
        // Filled in a loop, because the session layer changed when these
        // fields exist. They used to be rendered by AuthGate *after*
        // hydration, so a locator could not resolve one until React was live
        // and a fill was necessarily seen. The sign-in page is server-rendered
        // now: the inputs are in the initial HTML, and a fill that lands before
        // hydration sets the DOM value while React's state stays empty — which
        // leaves the submit button disabled, since it enables on that state.
        // The failure mode is a 30s click timeout on a page that looks correct
        // in a screenshot.
        const email = page.locator('input[type="email"]');
        const password = page.locator('input[type="password"]');
        const signIn = page.getByRole("button", { name: "Sign in" });
        //
        // Filled once and then waited on. Re-filling is not a recovery: if the
        // first fill landed before hydration, every later one lands on a React
        // that has already decided the field is empty.
        await email.fill(admin.email);
        await password.fill(admin.password);
        const deadline = Date.now() + 30_000;
        let interactive = false;
        while (Date.now() < deadline) {
          if (await signIn.isEnabled()) {
            interactive = true;
            break;
          }
          await page.waitForTimeout(200);
        }
        if (!interactive) {
          throw new Error(
            "sign-in form never became interactive: the submit button stayed disabled " +
              `for 30s after filling both fields. Landed on ${page.url()}; ` +
              `email field holds ${JSON.stringify(await email.inputValue())}.` +
              problemReport(),
          );
        }
        await signIn.click();
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
      } catch (err) {
        // Any failure in here — a locator timeout, a failed assertion — gets
        // what the browser saw attached. Diagnostics wired to one specific
        // failure are diagnostics that are absent for every other one, which is
        // how a thumbnail that never rendered presented as a bare 120s timeout
        // with nothing to say whether the upload had even reached the network.
        throw new Error(`${err instanceof Error ? err.message : String(err)}${problemReport()}`, {
          cause: err,
        });
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

    it("photos resize round-trips on the gateway AND through CloudFront (Bearer survives the edge)", async () => {
      // Unlike the broker's HMAC-gated data/sync/app-data planes, an app's own
      // routes (e.g. photos /api/resize) sit behind the gateway's Cognito JWT
      // authorizer — they're user-facing, so they take the signed-in user's id
      // token as a Bearer credential, not an app HMAC signature.
      //
      // Drive it through BOTH origins, because the CloudFront leg is the only
      // place in this journey where an Authorization header crosses the edge.
      // The real SPA sends this call to the distribution: resolveAppApiSource
      // builds `${apiGatewayUrl}/apps/photos` from runtime config, and Part A
      // fills that config value with publicBaseUrl (cli-install-app.ts), so
      // CloudFront is the production path for every JWT-gated app route. The
      // header only reaches the origin because the default cache behavior
      // carries the AllViewerExceptHostHeader origin request policy; drop that
      // policy and this 401s while every *unauthenticated* CloudFront assertion
      // in this file still passes. Keeping the gateway leg disambiguates a
      // failure: both legs failing implicates the authorizer or the handler,
      // only the edge leg failing implicates header forwarding.
      const post = (base: string) =>
        fetchWhenReady(`${base}/apps/photos/api/resize`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.idToken}`,
          },
          // The handler takes { targetId } and resizes to its own fixed max
          // width; there is no caller-supplied width.
          body: JSON.stringify({ targetId: syncedRecordId }),
        });

      const viaGateway = await post(config.apiGatewayUrl!);
      expect(viaGateway.status).toBe(200);

      const viaEdge = await post(config.publicBaseUrl!);
      expect(
        viaEdge.status,
        "JWT Bearer must survive CloudFront — check the default behavior's " +
          "AllViewerExceptHostHeader origin request policy",
      ).toBe(200);
      expect((viaEdge.headers.get("via") ?? "").toLowerCase()).toContain("cloudfront");
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
      //
      // The app root without its trailing slash, which is the spelling the
      // platform can register as a public route — see the trailing-slash step
      // above. This step is about the distribution and its edge cache, so it
      // asks for the shell the way an anonymous caller can actually get it
      // rather than re-testing the gate.
      const spa = await fetchWhenReady(`${base}/apps/photos`);
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

      // Edge hit — specifically on a FRESHLY SIGNED url, not a re-fetch of the
      // same one. This is the property that makes Part B deliver anything: the
      // shared/* cache policy excludes the signed-URL params
      // (Expires/Signature/Key-Pair-Id) from the cache key, so a *new* signature
      // for an already-cached path still hits. Re-fetching the identical url
      // would pass even with `queryStringBehavior: "all"` — i.e. it would prove
      // nothing, since every real request carries a newly minted signature.
      await pollForEdgeHit(url); // prime the POP for this path

      // Wait past a second boundary: Expires is `now + 3600` in integer seconds,
      // so a mint within the same second is byte-identical to the first url and
      // we'd just be re-testing one cache key again.
      await new Promise((r) => setTimeout(r, 1500));
      const freshRes = await cloudApp(drive).fetch(`/data/records/${syncedRecordId}/file-url`);
      expect(freshRes.status).toBe(200);
      const { url: freshUrl } = (await freshRes.json()) as { url: string };
      expect(freshUrl, "second mint must produce a distinct signature").not.toBe(url);
      // Same object, new signature — so any cache miss is the cache key, not the path.
      expect(new URL(freshUrl).pathname).toBe(signed.pathname);

      const xCache = await pollForEdgeHit(freshUrl);
      expect(
        xCache,
        `freshly-signed url missed the edge (last x-cache: ${xCache}) — the shared/* ` +
          "cache policy must exclude query strings from the cache key",
      ).toMatch(/Hit from cloudfront/i);

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
      // Identified by `apigw-requestid`, which only API Gateway sets. This used
      // to look for "<" in the body on the reasoning that the gateway answers
      // HTML — true when every app path was public, and no longer: the session
      // authorizer answers this one with API Gateway's own JSON 401. The header
      // says what the body only implied, and says it whatever the status.
      expect(
        appsProbe.headers.get("apigw-requestid"),
        "an apps/* path must reach the gateway origin, never the S3 files origin",
      ).toBeTruthy();
      expect((appsProbe.headers.get("content-type") ?? "").toLowerCase()).not.toContain(
        "octet-stream",
      );
      // And whatever it answers, it is not the object: no app-private bytes are
      // reachable through the distribution.
      expect(appsProbe.status).not.toBe(200);
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
