/**
 * Scheduled jobs from the app's side: `verifyJob` on both surfaces, and the
 * server-side helpers that list a user's jobs, start a run and link to the
 * consent page.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDelegationKeyCache } from "../src/delegation";
import { jobConsentUrl, jobRefusal, listJobs, runJobNow, verifyJob } from "../src/jobs";

const BASE = "https://abc.execute-api.us-east-1.amazonaws.com";
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const KID = "kid-1";
const saved = { ...process.env };
const CREDS = { appId: "probe", hmacSecret: "s", dataServerUrl: `${BASE}/apps/probe` };

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function token(over: Record<string, unknown> = {}): string {
  const input = `${b64({ alg: "ES256", typ: "JWT", kid: KID })}.${b64({
    sub: "user-1",
    aud: "probe",
    sk_dlg: "enr-1",
    sk_mode: "readwrite",
    sk_channel: "job",
    sk_job: "tick",
    sk_run: "run-1",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
    ...over,
  })}`;
  const sig = sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `skd_${input}.${sig.toString("base64url")}`;
}

const req = (headers: Record<string, string>) => ({ headers: new Headers(headers) });

let fetchMock: ReturnType<typeof vi.fn>;
let answer: (url: string, init?: RequestInit) => Response;

beforeEach(() => {
  resetDelegationKeyCache();
  answer = () => new Response("{}", { status: 200 });
  fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    if (String(input) === `${BASE}/connect/jwks.json`) {
      return new Response(
        JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: KID }] }),
      );
    }
    return answer(String(input), init);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...saved };
});

describe("verifyJob in the cloud", () => {
  beforeEach(() => {
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
    process.env.STARKEEP_APP_ID = "probe";
    process.env.STARKEEP_CLOUD_DATA_BASE = BASE;
  });

  it("returns the run's user, job, run id, mode and token", async () => {
    const t = token();
    expect(await verifyJob(req({ authorization: `Bearer ${t}` }), "tick")).toEqual({
      userId: "user-1",
      job: "tick",
      runId: "run-1",
      mode: "readwrite",
      token: t,
    });
  });

  it("refuses another job's token, an outside client's token and a token without its run", async () => {
    for (const t of [
      token({ sk_job: "other" }),
      token({ sk_channel: "app", sk_job: undefined, sk_run: undefined }),
      token({ sk_run: undefined }),
      token({ aud: "photos" }),
      token({ exp: Math.floor(Date.now() / 1000) - 1 }),
    ]) {
      expect(await verifyJob(req({ authorization: `Bearer ${t}` }), "tick")).toBeNull();
    }
    expect(await verifyJob(req({}), "tick")).toBeNull();
  });
});

describe("verifyJob on the local surface", () => {
  it("refuses every request, because no job runs locally", async () => {
    delete process.env.STARKEEP_APP_CLIENT_MODE;
    expect(await verifyJob(req({ authorization: `Bearer ${token()}` }), "tick")).toBeNull();
  });
});

describe("jobRefusal", () => {
  it("answers 404, so a probe of the path learns nothing", () => {
    expect(jobRefusal().status).toBe(404);
  });
});

describe("listJobs and runJobNow", () => {
  it("list the user's jobs with the user's token beside the signature", async () => {
    const jobs = [{ name: "tick", consentUrl: `${BASE}/connect/job?app=probe&job=tick` }];
    answer = () => Response.json({ jobs });
    expect(await listJobs("probe", { userToken: "id-token", creds: CREDS })).toEqual({
      cloudRequired: false,
      jobs,
    });
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe(`${BASE}/apps/probe/jobs`);
    expect((init as RequestInit).headers).toMatchObject({
      "X-Starkeep-User-Token": "id-token",
      "X-Starkeep-App-Id": "probe",
    });
  });

  it("start a run and return its id, or say why not", async () => {
    answer = () => Response.json({ runId: "run-9" }, { status: 202 });
    expect(await runJobNow("probe", "tick", { userToken: "t", creds: CREDS })).toEqual({
      ok: true,
      runId: "run-9",
    });
    expect(fetchMock.mock.calls.at(-1)![0]).toBe(`${BASE}/apps/probe/jobs/tick/run`);
    answer = () => Response.json({ error: "The job is running", code: "running" }, { status: 409 });
    expect(await runJobNow("probe", "tick", { userToken: "t", creds: CREDS })).toEqual({
      ok: false,
      cloudRequired: false,
      status: 409,
      code: "running",
      error: "The job is running",
    });
  });

  it("report cloudRequired on the local surface", async () => {
    answer = () => Response.json({ error: "x", code: "cloud-required" }, { status: 501 });
    const local = { ...CREDS, dataServerUrl: "http://127.0.0.1:9820" };
    expect(await listJobs("probe", { userToken: null, creds: local })).toEqual({
      cloudRequired: true,
      jobs: [],
    });
    expect(await runJobNow("probe", "tick", { userToken: null, creds: local })).toEqual({
      ok: false,
      cloudRequired: true,
    });
  });
});

describe("jobConsentUrl", () => {
  it("adds the browser's zone and the return path to the consent page's address", () => {
    const url = new URL(
      jobConsentUrl(
        { consentUrl: `${BASE}/connect/job?app=probe&job=tick` },
        { timeZone: "Europe/London", returnTo: "/apps/probe/settings" },
      ),
    );
    expect(url.origin).toBe(BASE);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      app: "probe",
      job: "tick",
      tz: "Europe/London",
      return: "/apps/probe/settings",
    });
  });
});
