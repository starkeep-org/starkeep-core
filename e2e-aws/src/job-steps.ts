/**
 * A scheduled job, end to end on real AWS: a user turns the app's job on on
 * the platform's consent page, the platform runs it on request and at its
 * time of day, and turning it off stops it.
 *
 * What the steps hold (STA-104):
 *
 * - The consent page writes the enrollment through a real managed login and
 *   links back to the app.
 * - "Run now" reaches the dispatcher, which invokes the app's own function,
 *   and the run writes the app's row as the enrolled user.
 * - The dispatcher runs a due enrollment when it wakes, and moves the job's
 *   next run to the next day.
 * - The gateway answers 404 for the platform's job path, so no outside caller
 *   reaches the app's job route.
 * - A `job` token opens no route declared `auth: "delegated"`.
 * - Turning the job off on the connections page stops "run now".
 *
 * The app's own pages drive the job, as a browser would: `/api/jobs` lists
 * the user's jobs and `/api/jobs/<name>/run` starts one, each through the
 * app's server with the user's session cookie. Probe serves both.
 */

import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetParameterCommand, GetParametersByPathCommand, SSMClient } from "@aws-sdk/client-ssm";
import { signedFetch, type AppCredentials } from "@starkeep/app-client";
import { chromium, type Browser } from "./browser.js";
import { signInIfAsked } from "./delegation-steps.js";
import { REGION } from "./env.js";
import type { TestStackConfig } from "./run-state.js";

export interface JobStepsContext {
  readonly config: () => TestStackConfig;
  readonly appId: string;
  /** A job the manifest declares, with a route at `/_starkeep/jobs/<name>`. */
  readonly job: string;
  /** The app's MCP route, declared `auth: "delegated"`, for the refusal step. */
  readonly mcpPath?: string;
  readonly admin: () => { email: string; password: string };
  /** The `Cookie` header of a signed-in browser session on the app. */
  readonly cookie: () => Promise<string>;
  /** An app-private table the job writes, and the column its notes land in. */
  readonly table: string;
  /**
   * The vault secret the job rotates, when the app has one: the app stores it
   * at `PUT /api/vault/<name>`, and each run reads it, writes `<value>+1`, and
   * names the value it read in its note, as Probe's `probe-tick` does.
   */
  readonly vaultSecret?: string;
  /** The app's cloud credentials, to sign a call as the app's server does. */
  readonly appCreds: () => AppCredentials;
}

interface JobState {
  name: string;
  enabled: boolean;
  timeOfDay: string | null;
  timeZone: string | null;
  nextRunAt: number | null;
  running: boolean;
  lastRun: {
    status: string;
    startedAt: number | null;
    finishedAt: number | null;
    message: string | null;
  } | null;
  attention: string | null;
}

/** `HH:MM` in UTC, `minutes` from now, rounded up to the next whole minute. */
function utcTimeAhead(minutes: number): { time: string; at: number } {
  const at = Math.ceil((Date.now() + minutes * 60_000) / 60_000) * 60_000;
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return { time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`, at };
}

/** The deployment's delegation signing key, as the installer stored it. */
async function signingKeyPem(stackPrefix: string): Promise<string> {
  const ssm = new SSMClient({ region: REGION });
  const param = await ssm.send(
    new GetParameterCommand({
      Name: `/${stackPrefix}/app-creds/_delegation-signing`,
      WithDecryption: true,
    }),
  );
  return (JSON.parse(param.Parameter!.Value!) as { privateKeyPem: string }).privateKeyPem;
}

/** A token signed with the deployment's delegation key, as the platform signs one. */
function signToken(privateKeyPem: string, claims: Record<string, unknown>): string {
  const privateKey = createPrivateKey(privateKeyPem);
  const der = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const kid = createHash("sha256").update(der).digest("base64url").slice(0, 16);
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const input = `${b64({ alg: "ES256", typ: "JWT", kid })}.${b64(claims)}`;
  const sig = sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `skd_${input}.${sig.toString("base64url")}`;
}

export function defineJobSteps(d: JobStepsContext): void {
  let browser: Browser | undefined;
  const gateway = () => d.config().apiGatewayUrl!.replace(/\/+$/, "");
  const edge = () => d.config().publicBaseUrl!.replace(/\/+$/, "");
  const appBase = () => `${edge()}/apps/${d.appId}`;
  /** When the job is due by its time of day, set by the consent step. */
  let dueAt = 0;
  let manualRunId = "";
  /** This run's first secret value, so a kept stack's older values never match. */
  const secretValue = `tier3-${Date.now()}`;

  afterAll(async () => {
    await browser?.close();
  });

  async function jobState(): Promise<JobState> {
    const res = await fetch(`${appBase()}/api/jobs`, { headers: { cookie: await d.cookie() } });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { cloudRequired: boolean; jobs: JobState[] };
    expect(body.cloudRequired).toBe(false);
    const job = body.jobs.find((j) => j.name === d.job);
    expect(job, `${d.job} is not listed`).toBeDefined();
    return job!;
  }

  async function runNow(): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${appBase()}/api/jobs/${d.job}/run`, {
      method: "POST",
      headers: { cookie: await d.cookie() },
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function notes(): Promise<string> {
    const res = await fetch(`${appBase()}/api/local-data/app-data/db/${d.table}`, {
      headers: { cookie: await d.cookie() },
    });
    expect(res.status).toBe(200);
    return await res.text();
  }

  /** Wait until the job's last run started at or after `since` and finished. */
  async function settledRunSince(since: number): Promise<JobState> {
    let state: JobState | undefined;
    await expect
      .poll(
        async () => {
          state = await jobState();
          const last = state.lastRun;
          return !state.running && !!last && (last.startedAt ?? 0) >= since && last.status !== "";
        },
        { timeout: 120_000, interval: 3_000 },
      )
      .toBe(true);
    return state!;
  }

  it(`turns ${d.job} on through the job consent page`, async () => {
    const due = utcTimeAhead(2);
    dueAt = due.at;
    browser = await chromium.launch();
    const page = await browser.newPage();
    const query = new URLSearchParams({
      app: d.appId,
      job: d.job,
      tz: "UTC",
      return: `/apps/${d.appId}/`,
    });
    await page.goto(`${gateway()}/connect/job?${query}`);
    await page.locator('input[name="when"][value="time"]').check();
    await page.locator('input[name="time"]').fill(due.time);
    await page.getByRole("button", { name: "Sign in and turn the job on" }).click();
    await signInIfAsked(page, d.admin().email, d.admin().password);
    await page.getByRole("heading", { name: "Background job on" }).waitFor({ timeout: 60_000 });
    expect(await page.getByRole("link", { name: /^Back to / }).getAttribute("href")).toBe(
      `${edge()}/apps/${d.appId}/`,
    );
    await page.close();

    const state = await jobState();
    expect(state).toMatchObject({
      enabled: true,
      timeOfDay: due.time,
      timeZone: "UTC",
      attention: null,
    });
    expect(state.nextRunAt).toBe(due.at);
  });

  if (d.vaultSecret) {
    it("stores a vault secret the browser can list but never read back", async () => {
      const cookie = await d.cookie();
      const save = await fetch(`${appBase()}/api/vault/${d.vaultSecret}`, {
        method: "PUT",
        headers: { cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ value: secretValue }),
      });
      expect(save.status, await save.clone().text()).toBe(200);
      const listed = await fetch(`${appBase()}/api/vault`, { headers: { cookie } });
      const text = await listed.text();
      expect(text).toContain(d.vaultSecret);
      expect(text).not.toContain(secretValue);
      // The browser's own read, through the app's signing proxy.
      const read = await fetch(`${appBase()}/api/local-data/vault/${d.vaultSecret}`, {
        headers: { cookie },
      });
      expect(read.status).toBe(403);
      expect(await read.text()).not.toContain(secretValue);
    });
  }

  it(`runs ${d.job} on request, and the run writes the app's row as the user`, async () => {
    const started = Date.now() - 5_000;
    const answer = await runNow();
    expect(answer.status, JSON.stringify(answer.body)).toBe(202);
    manualRunId = answer.body.runId as string;
    expect(typeof manualRunId).toBe("string");

    const state = await settledRunSince(started);
    expect(state.lastRun?.status, state.lastRun?.message ?? "").toBe("ok");
    expect(await notes()).toContain(`tick-${manualRunId}`);
    if (d.vaultSecret) expect(await notes()).toContain(`read ${secretValue}`);
    // A manual run leaves the schedule alone.
    expect(state.nextRunAt).toBe(dueAt);
  });

  it(`runs ${d.job} at its time of day when the dispatcher wakes`, async () => {
    // The rule wakes the dispatcher every five minutes. Invoking it the way the
    // rule does, once the job is due, keeps the step under the five minutes.
    const wait = dueAt + 5_000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const lambda = new LambdaClient({ region: REGION });
    await lambda.send(
      new InvokeCommand({
        FunctionName: `${d.config().stackPrefix}-app-cloud-data-server-dispatcher`,
        InvocationType: "RequestResponse",
        Payload: Buffer.from(
          JSON.stringify({ source: "aws.events", "detail-type": "Scheduled Event" }),
        ),
      }),
    );
    // The rule's own tick may have run it first; either way the run is due.
    const state = await settledRunSince(dueAt);
    expect(state.lastRun?.status, state.lastRun?.message ?? "").toBe("ok");
    // The next run is the same time tomorrow.
    expect(state.nextRunAt).toBe(dueAt + 24 * 60 * 60 * 1000);
    const scheduled = /Wrote tick-(\S+)/.exec(state.lastRun?.message ?? "")?.[1];
    expect(scheduled).toBeDefined();
    expect(scheduled).not.toBe(manualRunId);
    expect(await notes()).toContain(`tick-${scheduled}`);
    // The second run read the value the first run rotated.
    if (d.vaultSecret) expect(await notes()).toContain(`read ${secretValue}+1`);
  });

  it("answers 404 for the platform's job path, through CloudFront and on the gateway", async () => {
    for (const url of [
      `${appBase()}/_starkeep/jobs/${d.job}`,
      `${gateway()}/apps/${d.appId}/_starkeep/jobs/${d.job}`,
    ]) {
      const res = await fetch(url, { method: "POST", redirect: "manual" });
      expect(res.status, url).toBe(404);
    }
  });

  if (d.mcpPath) {
    it("a job token opens no route declared auth: delegated", async () => {
      const privateKeyPem = await signingKeyPem(d.config().stackPrefix);
      const now = Math.floor(Date.now() / 1000);
      const token = signToken(privateKeyPem, {
        sub: "any-user",
        aud: d.appId,
        sk_dlg: "any-enrollment",
        sk_mode: "readwrite",
        sk_channel: "job",
        sk_job: d.job,
        sk_run: "any-run",
        iat: now,
        exp: now + 300,
      });
      const res = await fetch(`${appBase()}${d.mcpPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(401);
    });
  }

  if (d.vaultSecret) {
    it("refuses an outside client's delegation on every vault route", async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = signToken(await signingKeyPem(d.config().stackPrefix), {
        sub: "any-user",
        aud: d.appId,
        sk_dlg: "any-delegation",
        sk_mode: "readwrite",
        sk_channel: "app",
        iat: now,
        exp: now + 300,
      });
      for (const [method, path] of [
        ["GET", "/vault"],
        ["GET", `/vault/${d.vaultSecret}`],
        ["PUT", `/vault/${d.vaultSecret}`],
        ["DELETE", `/vault/${d.vaultSecret}`],
      ] as const) {
        const res = await signedFetch(d.appCreds(), path, {
          method,
          delegation: token,
          ...(method === "PUT"
            ? { headers: { "Content-Type": "application/json" }, body: '{"value":"x"}' }
            : {}),
        });
        expect(res.status, `${method} ${path}`).toBe(403);
      }
    });
  }

  it(`turning ${d.job} off on the connections page stops "run now"`, async () => {
    const page = await browser!.newPage();
    await page.goto(`${gateway()}/connections`);
    await signInIfAsked(page, d.admin().email, d.admin().password);
    const row = page
      .getByRole("row")
      .filter({ has: page.getByRole("cell", { name: d.job, exact: true }) })
      .filter({ has: page.getByRole("cell", { name: d.appId, exact: true }) });
    await row.getByRole("button", { name: "Turn off" }).click();
    await page.waitForURL(/\/connections$/);
    await page.close();

    expect((await jobState()).enabled).toBe(false);
    const answer = await runNow();
    expect(answer.status).toBe(409);
    expect(answer.body.code).toBe("not-enabled");
  });
}

/**
 * After an uninstall and a reinstall, the app's job has no enrollment at all:
 * the uninstall deleted the row, so even its last run is gone.
 */
export async function expectNoEnrollment(
  appBase: string,
  job: string,
  cookie: string,
): Promise<void> {
  const res = await fetch(`${appBase}/api/jobs`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { jobs: JobState[] };
  const state = body.jobs.find((j) => j.name === job);
  expect(state).toMatchObject({ enabled: false, lastRun: null });
}

/** After an uninstall, no secret remains under the app's vault path. */
export async function expectNoVault(stackPrefix: string, appId: string): Promise<void> {
  const ssm = new SSMClient({ region: REGION });
  const page = await ssm.send(
    new GetParametersByPathCommand({
      Path: `/${stackPrefix}/app-creds/_vault/${appId}`,
      Recursive: true,
      WithDecryption: false,
    }),
  );
  expect((page.Parameters ?? []).map((p) => p.Name)).toEqual([]);
}
