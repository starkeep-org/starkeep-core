/**
 * The tier-3 cloud journey, as a harness any conforming app can be driven
 * through.
 *
 * One scripted run against a real AWS account, idempotent against the stack
 * prefix it is given: bootstrap, admin sign-in, cloud-data-server, Drive, the
 * app under test, sync, the data plane, the session gate, CloudFront, and
 * uninstall. Steps are ordered and cumulative — `bail: 1` in vitest.config.ts
 * stops the run at the first failure instead of cascading for tens of minutes.
 *
 * Repeat runs against a kept-up stack re-execute every install, which is the
 * idempotency coverage (CloudFormation verify, Pulumi no-change up, DDL
 * re-apply) the plan asks for; the first run against a bare account covers cold
 * start.
 *
 * Every assertion registered here is a platform assertion. The app arrives as a
 * `JourneyApp` describing only what differs between apps — its id, its
 * directory, the label keys and table its manifest declared, the route behind
 * its JWT authorizer — and contributes its own app-level assertions through
 * `extraSteps`. That is what lets core run this against its own fixture with no
 * other checkout on the machine, and lets an app repository run the identical
 * journey against the real application.
 */

import { describe, it, expect, afterAll, afterEach, beforeAll } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chromium, watchPageProblems, signInWithBrowser } from "./browser.js";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import {
  installAppDirect,
  driveCreds,
  createRecordWithBytes,
  eventually,
  solidPng,
  type LdsApp,
} from "@starkeep/e2e";
import { signedFetch, USER_TOKEN_HEADER, type AppCredentials } from "@starkeep/app-client";
import { cloudDataServerBundleSha256Base64, createDsqlRegistry } from "@starkeep/admin-installer";
import { LambdaClient, GetFunctionConfigurationCommand } from "@aws-sdk/client-lambda";
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
import type { JourneyApp, JourneyContext } from "./journey-app.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface CloudJourneyOptions {
  /**
   * Where this run keeps its state (`<baseDir>/.run/<prefix>`). Defaults to the
   * e2e-aws package. A journey driven from another repository passes its own
   * directory: the dir holds that run's Cognito admin password and its registry
   * database, and writing those into a checkout the caller does not own would
   * put one repository's cloud credentials inside another's working tree.
   */
  runStateDir?: string;
}

/**
 * Register the journey for `app`. Called at module top level from a `.test.ts`
 * file; vitest collects the steps in registration order and the config runs
 * them serially.
 */
export function defineCloudJourney(app: JourneyApp, options: CloudJourneyOptions = {}): void {
  const paths = runPaths(STACK_PREFIX, options.runStateDir);

  // Shared journey state, filled in step order.
  let outputs: BootstrapOutputs;
  let session: AdminSession;
  let admin: AdminCredentials;
  let config: TestStackConfig;
  let lds: LocalDataServer | undefined;
  let drive: LdsApp;
  let appUnderTest: LdsApp;
  let syncedRecordId: string;
  // What the real browser uploads through the cloud-served UI: its bytes enter
  // the cloud via browser→proxy→broker→S3, never touching the local data
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
   * What an app's own steps read. Getters rather than values: the steps are
   * registered before the journey runs and the state fills in step by step, so
   * a captured value would be `undefined` forever.
   */
  const ctx: JourneyContext = {
    config: () => config,
    session: () => session,
    adminCredentials: () => admin,
    localApp: () => appUnderTest,
    cloudApp: () => cloudApp(appUnderTest),
    drive: () => drive,
    cloudDrive: () => cloudApp(drive),
    ldsUrl: () => lds!.url,
    ldsLogs: () => lds?.logs() ?? "",
    dataDir: () => paths.dataDir,
    signInToApp: (appId) => signInToApp(appId),
  };

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
  async function fetchWhenReady(url: string, init?: RequestInit, attempts = 15): Promise<Response> {
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
    `tier-3 cloud journey: ${app.appId} (prefix ${STACK_PREFIX})`,
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
      beforeAll(async () => {
        // The profile describes an app that is actually there, and is actually
        // that app. Checked here because everything downstream trusts it: the
        // install CLI resolves the app by scanning for this id, so a profile
        // naming the wrong directory fails as "no app with manifest id X",
        // fifteen minutes and one Pulumi-provisioned stack into the run. One
        // stat and one JSON parse buy that back.
        const manifestPath = join(app.appDir, "starkeep.manifest.json");
        if (!existsSync(manifestPath)) {
          throw new Error(
            `${app.appId}'s profile points at ${app.appDir}, which holds no ` +
              "starkeep.manifest.json. appDir must be the app's own source directory.",
          );
        }
        const declaredId = (JSON.parse(readFileSync(manifestPath, "utf-8")) as { id?: string }).id;
        if (declaredId !== app.appId) {
          throw new Error(
            `${app.appDir} declares id "${declaredId}", but the profile calls it ` +
              `"${app.appId}". The install CLI resolves the app by the manifest id.`,
          );
        }

        // The app's own refusal to start, before the first AWS call. A machine
        // state that would take the run down — a dev server already holding the
        // app's directory, say — costs fifteen minutes and one Pulumi-provisioned
        // stack to discover any later.
        await app.preflight?.();
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
          // The app's PARENT, not the app. `resolveAppDir` scans each entry's
          // children for a manifest whose id matches, so naming the app's own
          // directory would have it look inside the app for a nested copy of
          // itself and find nothing. Derived rather than configured: the parent
          // of an app's directory is a directory that contains that app, by
          // construction, so there is nothing here for a caller to get wrong.
          appParentDirs: [dirname(app.appDir)],
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

      it(`installs ${app.appId} in the cloud (bundle, Lambda, routes)`, async () => {
        // The manifest is read from the app's own directory rather than restated
        // here: the local install and the cloud install must agree about what the
        // app asked for, and a copy in this file could only ever disagree.
        const manifest = JSON.parse(
          readFileSync(join(app.appDir, "starkeep.manifest.json"), "utf-8"),
        ) as Record<string, unknown>;
        appUnderTest = await installAppDirect(lds!.url, manifest);
        await runInstallCli("cli-install-app", [app.appId], paths, session);

        const res = await cloudApp(appUnderTest).fetch("/health");
        expect(res.status).toBe(200);
      });

      it(`syncs a record to the cloud: row + blob under Drive, origin ${app.appId}`, async () => {
        const { record } = await createRecordWithBytes(appUnderTest, {
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
        expect(synced.originAppId ?? synced.origin_app_id).toBe(app.appId);

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
        const cloudUnderTest = cloudApp(appUnderTest);
        const { flag, valued } = app.labelKeys;

        // Two labels in one batch — one valueless, one valued — on the record
        // that synced up above.
        //
        // Both are keys the app actually declares in its manifest, which is load
        // bearing rather than cosmetic: the broker rejects an undeclared key with
        // a 400, so an inert test string would fail here and not at the thing this
        // step is testing. That is why the keys arrive on the app profile instead
        // of being written down here — a name in this file could go stale against
        // the manifest, and the failure would look like a broker fault.
        //
        // Neither may be the app's size-class key: a size-class label claims the
        // record is a derived rung of some original, which would make later steps
        // read this record as its own variant.
        const write = await cloudUnderTest.fetch("/data/labels", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            labels: [
              { recordId: syncedRecordId, key: flag },
              { recordId: syncedRecordId, key: valued, value: "e2e" },
            ],
          }),
        });
        expect(write.status).toBe(200);
        expect((await write.json()) as { written: number }).toEqual({ written: 2 });

        // The registry is readable cross-app — the reason keys are declared in a
        // manifest rather than counted at runtime.
        const keysRes = await cloudApp(drive).fetch(
          `/data/label-keys?app=${encodeURIComponent(app.appId)}`,
        );
        expect(keysRes.status).toBe(200);
        const { labelKeys } = (await keysRes.json()) as { labelKeys: Array<{ label: string }> };
        expect(labelKeys.map((k) => k.label)).toEqual(
          expect.arrayContaining([`${app.appId}/${flag}`, `${app.appId}/${valued}`]),
        );

        // Hydration: Drive holds no per-type grants but sees every app's labels
        // on a record it can read.
        const hydrated = await cloudApp(drive).fetch("/data/records?include=labels&limit=1000");
        const { records } = (await hydrated.json()) as {
          records: Array<{ id: string; labels?: Array<{ label: string; value: string | null }> }>;
        };
        const labelled = records.find((r) => r.id === syncedRecordId);
        expect(labelled?.labels?.map((l) => l.label).sort()).toEqual(
          [`${app.appId}/${flag}`, `${app.appId}/${valued}`].sort(),
        );

        // The reverse query — the thing labels exist for, and the query the
        // measured index shape was chosen for. Presence first.
        const presence = await cloudApp(drive).fetch(
          `/data/records?label=${encodeURIComponent(`${app.appId}/${flag}`)}&limit=1000`,
        );
        expect(presence.status).toBe(200);
        const presenceBody = (await presence.json()) as {
          records: Array<{ id: string }>;
          nextCursor: string | null;
        };
        expect(presenceBody.records.map((r) => r.id)).toContain(syncedRecordId);

        // Then the exact-value seek, which is why `value` is in the index key.
        const byValue = await cloudApp(drive).fetch(
          `/data/records?label=${encodeURIComponent(`${app.appId}/${valued}`)}&labelValue=e2e&limit=1000`,
        );
        const matched = (await byValue.json()) as { records: Array<{ id: string }> };
        expect(matched.records.map((r) => r.id)).toContain(syncedRecordId);

        const byWrongValue = await cloudApp(drive).fetch(
          `/data/records?label=${encodeURIComponent(`${app.appId}/${valued}`)}&labelValue=nope&limit=1000`,
        );
        const unmatched = (await byWrongValue.json()) as { records: Array<{ id: string }> };
        expect(unmatched.records.map((r) => r.id)).not.toContain(syncedRecordId);

        // Retraction is a tombstone, and `deleted_at` being a key column of the
        // reverse index is what keeps tombstones out of the scanned range.
        const retract = await cloudUnderTest.fetch("/data/labels/retract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ labels: [{ recordId: syncedRecordId, key: valued }] }),
        });
        expect(retract.status).toBe(200);

        const afterRetract = await cloudApp(drive).fetch(
          `/data/records?label=${encodeURIComponent(`${app.appId}/${valued}`)}&limit=1000`,
        );
        const remaining = (await afterRetract.json()) as { records: Array<{ id: string }> };
        expect(remaining.records.map((r) => r.id)).not.toContain(syncedRecordId);

        // ...and the valueless label on the same record is untouched by it.
        const stillFlagged = await cloudApp(drive).fetch(
          `/data/records?label=${encodeURIComponent(`${app.appId}/${flag}`)}&limit=1000`,
        );
        const flagged = (await stillFlagged.json()) as { records: Array<{ id: string }> };
        expect(flagged.records.map((r) => r.id)).toContain(syncedRecordId);

        // Now put the record back the way this step found it: later steps read
        // this same record, and a label left on it is state leaking across steps.
        // Retracting this one also covers the valueless retract path, which the
        // valued retraction above does not.
        const retractFlag = await cloudUnderTest.fetch("/data/labels/retract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ labels: [{ recordId: syncedRecordId, key: flag }] }),
        });
        expect(retractFlag.status).toBe(200);

        const afterFlagRetract = await cloudApp(drive).fetch(
          `/data/records?label=${encodeURIComponent(`${app.appId}/${flag}`)}&limit=1000`,
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

      it(`${app.appId} cloud static handler serves`, async () => {
        // The app root, spelled the way the platform can actually register it.
        // `/` is declared public and becomes `ANY /apps/<appId>`; the manifest's
        // reach is real here rather than aspirational.
        const res = await fetch(`${config.apiGatewayUrl}/apps/${app.appId}`);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("<");
      });

      it("the app root's trailing-slash spelling is gated, and that is a platform limit", async () => {
        // Asserted rather than left as a surprise. API Gateway v2 refuses a route
        // key with an empty path segment, so `ANY /apps/<appId>/` cannot exist
        // beside `ANY /apps/<appId>` — the same limit that makes the manifest's
        // `GET /` collapse to the bare prefix. The trailing-slash spelling
        // therefore falls to the gated catch-all.
        //
        // It fails closed, which is why it is acceptable: an anonymous caller
        // gets 401 rather than the shell. Through CloudFront, which is how the
        // app is actually reached, a browser navigation to either spelling is
        // redirected to sign-in and a signed-in one is let through — so no user
        // meets this. It is pinned here so that if the routing ever changes, the
        // change is deliberate and visible rather than silent.
        const withSlash = await fetch(`${config.apiGatewayUrl}/apps/${app.appId}/`);
        expect(withSlash.status).toBe(401);
      });

      it(`${app.appId} data plane works through the cloud-served /api/local-data proxy`, async () => {
        // The seam that broke on cloud reinstall: the browser never signs; it
        // calls the app's OWN same-origin proxy (/api/local-data/...), served by
        // the cloud Lambda serving the app, which loads the app's HMAC secret from SSM
        // and forwards a *signed* request to the broker.
        //
        // This is what an app's own client does to read its library. Before the
        // fix it hit the gateway directly with only a Cognito token and got 401
        // "Missing X-Starkeep-App" headers; and the manifest only routed GET to
        // the proxy, so writes 404'd.
        //
        // The requests below carry a session cookie because that is now the only
        // way through: the gateway's session authorizer refuses the catch-all,
        // and the proxy refuses a caller it has not authenticated. Until the
        // session layer landed these same calls succeeded with no credential of
        // any kind, which was the exposure — the negative test immediately after
        // this one is what holds that closed.
        const cookie = await signInToApp(app.appId);
        const proxyBase = `${config.apiGatewayUrl}/apps/${app.appId}/api/local-data`;

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
        // here. Naming the app under test is what a check like this must not do:
        // the exposure propagated to Memo precisely because the second app was
        // never re-examined.
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

        const probes: Array<{ label: string; url: string; allow: number[]; init?: RequestInit }> =
          [];
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
            appId: appUnderTest.appId,
            hmacSecret: appUnderTest.hmacSecret,
            dataServerUrl: `${config.apiGatewayUrl}/apps/${encodeURIComponent(appUnderTest.appId)}`,
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
            appId: appUnderTest.appId,
            hmacSecret: appUnderTest.hmacSecret,
            dataServerUrl: `${config.apiGatewayUrl}/apps/${encodeURIComponent(appUnderTest.appId)}`,
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
        const url = `${config.apiGatewayUrl}/apps/${app.appId}/api/local-data/data/records?limit=1`;

        const anonymous = await fetch(url);
        expect(REFUSED).toContain(anonymous.status);

        const cookie = await signInToApp(app.appId);
        const authenticated = await fetch(url, { headers: { cookie } });
        expect(authenticated.status).toBe(200);

        // Sign-out clears the browser's copy of both cookies. It does not revoke
        // the refresh token — that is AdminUserGlobalSignOut, an operator action
        // rather than something a page can trigger — so what is asserted here is
        // what sign-out actually promises: the browser is told to drop them, and
        // a request carrying what is left is refused.
        const out = await fetch(`${config.apiGatewayUrl}/apps/${app.appId}/api/session/sign-out`, {
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

      // The browser steps run only for an app that says it has a UI worth
      // driving. An app without one still gets every other platform assertion;
      // what it cannot get is the S3-CORS-on-a-presigned-PUT coverage, which
      // exists nowhere else and needs a real browser to make the request.
      const browserSteps = app.browser ? it : it.skip;

      browserSteps(
        `drives the real cloud ${app.appId} UI end-to-end: sign in, upload, see the record`,
        async () => {
          // True browser e2e of the cloud-served app: a real Chromium loads the app,
          // signs in through Cognito, and uploads a file through the live file
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
          const appUrl = `${config.publicBaseUrl}/apps/${app.appId}/`;

          // Fresh tiny PNG → new content hash (the kept-up cloud dedupes by hash).
          const uploadName = `e2e-browser-${Date.now()}.png`;
          const uploadBytes = solidPng([...randomBytes(3)] as [number, number, number], 12);
          browserUploadName = uploadName;
          browserUploadBytes = uploadBytes;
          const uploadDir = await mkdtemp(join(tmpdir(), `${app.appId}-cloud-ui-`));
          const uploadPath = join(uploadDir, uploadName);
          await writeFile(uploadPath, uploadBytes);

          const browser = await chromium.launch();
          // Declared out here so the catch below can reach it; filled in as soon as
          // the page exists.
          let problemReport: () => string = () => "";
          try {
            const page = await browser.newPage();
            problemReport = watchPageProblems(page);
            await signInWithBrowser({
              page,
              appUrl,
              email: admin.email,
              password: admin.password,
              signedInControl: app.browser!.signedInControl,
              problemReport,
            });

            // Upload through the live file input and wait for the thumbnail to render.
            await page.locator('input[type="file"]').first().setInputFiles(uploadPath);
            await page
              .getByAltText(uploadName)
              .first()
              .waitFor({ state: "visible", timeout: 120_000 });

            // Cross-check the data plane: the shared record now exists in the cloud.
            const list = await cloudApp(appUnderTest).fetch("/data/records?limit=500");
            expect(list.status).toBe(200);
            const { records } = (await list.json()) as {
              records: Array<{ original_filename: string | null }>;
            };
            expect(records.some((r) => r.original_filename === uploadName)).toBe(true);
          } catch (err) {
            // Any failure in here — a locator timeout, a failed assertion — gets
            // what the browser saw attached; see watchPageProblems for why.
            throw new Error(
              `${err instanceof Error ? err.message : String(err)}${problemReport()}`,
              {
                cause: err,
              },
            );
          } finally {
            await browser.close();
          }
        },
      );

      browserSteps(
        "cloud-origin browser upload syncs down to the local data server (record + bytes)",
        async () => {
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
            const local = await appUnderTest.fetch("/data/records?limit=500&include=metadata");
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

          // The bytes came down too: the local file-url serves the exact bytes the
          // browser uploaded (mirrors the cloud-side byte round-trip in the ship
          // test, but proving the cloud→local blob transfer instead).
          const urlRes = await appUnderTest.fetch(`/data/records/${localRecord!.id}/file-url`);
          expect(urlRes.status).toBe(200);
          const { url } = (await urlRes.json()) as { url: string };
          const blob = await fetch(url);
          expect(blob.status).toBe(200);
          expect(Buffer.from(await blob.arrayBuffer()).equals(browserUploadBytes)).toBe(true);
        },
      );

      it(`${app.appId}'s JWT-gated route round-trips on the gateway AND through CloudFront (Bearer survives the edge)`, async () => {
        // Unlike the broker's HMAC-gated data/sync/app-data planes, an app's own
        // routes sit behind the gateway's Cognito JWT authorizer — they are
        // user-facing, so they take the signed-in user's id token as a Bearer
        // credential, not an app HMAC signature.
        //
        // Drive it through BOTH origins, because the CloudFront leg is the only
        // place in this journey where an Authorization header crosses the edge.
        // A real app client sends this call to the distribution: it builds
        // `${apiGatewayUrl}/apps/<appId>` from runtime config, and Part A fills
        // that config value with publicBaseUrl (cli-install-app.ts), so
        // CloudFront is the production path for every JWT-gated app route. The
        // header only reaches the origin because the default cache behavior
        // carries the AllViewerExceptHostHeader origin request policy; drop that
        // policy and this 401s while every *unauthenticated* CloudFront assertion
        // in this file still passes. Keeping the gateway leg disambiguates a
        // failure: both legs failing implicates the authorizer or the handler,
        // only the edge leg failing implicates header forwarding.
        const route = app.jwtRoute;
        const post = (base: string) =>
          fetchWhenReady(`${base}/apps/${app.appId}${route.path}`, {
            method: route.method ?? "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${session.idToken}`,
            },
            body: JSON.stringify(route.body(syncedRecordId)),
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

      it("writes an app-private row through the cloud /app-data plane", async () => {
        // App-specific tables live under /app-data/db/<table>; writes take a
        // { row } envelope whose keys are the manifest-declared columns.
        const table = app.appTable;
        const insert = await cloudApp(appUnderTest).fetch(`/app-data/db/${table.name}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ row: table.row(syncedRecordId) }),
        });
        expect(insert.status).toBe(200);

        const query = await cloudApp(appUnderTest).fetch(`/app-data/db/${table.name}`);
        expect(query.status).toBe(200);
        const body = await query.text();
        expect(body).toContain(table.expectInBody);
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

        // App entry point via CloudFront → gateway origin (default no-cache
        // behavior; AllViewerExceptHostHeader forwards viewer headers, strips
        // Host so the HTTP API accepts it). Retry through any propagation 5xx.
        //
        // The app root without its trailing slash, which is the spelling the
        // platform can register as a public route — see the trailing-slash step
        // above. This step is about the distribution and its edge cache, so it
        // asks for the shell the way an anonymous caller can actually get it
        // rather than re-testing the gate.
        const spa = await fetchWhenReady(`${base}/apps/${app.appId}`);
        expect(spa.status).toBe(200);
        const html = await spa.text();
        expect(html).toContain("<");
        expect((spa.headers.get("via") ?? "").toLowerCase()).toContain("cloudfront");

        // A content-hashed asset the shell references → the
        // /apps/*/_next/static/* behavior (CachingOptimized). These are
        // immutable, so the edge caches them: after a priming fetch a later fetch
        // reports `x-cache: Hit`. The path is the platform's cache-behavior
        // convention rather than a framework's, so every app serves its immutable
        // assets under it.
        const assetPattern = new RegExp(`/apps/${app.appId}/_next/static/[^"'\\\\]+`);
        const match = html.match(assetPattern);
        expect(match, "the app shell should reference a _next/static asset").toBeTruthy();
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
        // routes to the GATEWAY origin (default shell behavior) and can never
        // serve app-private S3 bytes. Prove it lands on the gateway, not S3.
        const appsProbe = await fetch(
          `${base}/apps/${app.appId}/syncable/does-not-exist-${Date.now()}.bin`,
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

      // The app's own assertions, registered against the same live stack. They
      // come after every platform step that sets up state they might read, and
      // before uninstall takes the app plane down.
      app.extraSteps?.(ctx);

      it(`uninstalls ${app.appId}: app plane gone, shared records persist`, async () => {
        await runInstallCli("cli-uninstall-app", [app.appId], paths, session);

        // App-plane access is gone (HMAC secret deleted → 401, or routes 404).
        const appGone = await cloudApp(appUnderTest).fetch("/health");
        expect([401, 403, 404]).toContain(appGone.status);

        // Shared records survive under Drive.
        const listRes = await cloudApp(drive).fetch("/data/records");
        expect(listRes.status).toBe(200);
        const { records } = (await listRes.json()) as { records: Array<{ id: string }> };
        expect(records.some((r) => r.id === syncedRecordId)).toBe(true);
      });
    },
  );
}
