/**
 * The example's background job, `digest`, and the page's job and vault routes.
 *
 * **The job.** The manifest declares `digest`, which the platform runs in the
 * cloud for each user who turns it on, at the user's time of day or when the
 * user clicks Run now. The platform's dispatcher calls
 * `POST /_starkeep/jobs/digest` with a `job` token and no session cookie, so
 * `app.ts` mounts the route ahead of the origin gate. `verifyJob` checks the
 * token, and every call the run makes forwards it, so the platform applies
 * the job's mode and the user's grant to each one.
 *
 * Each run plays a sync from a third-party service. It reads the user's
 * provider token from the vault, rotates it as such a provider would, and
 * writes the next value back before the run ends. It then counts the user's
 * example files and notes, and saves the counts as a new example file tagged
 * `digest`. The run's message names the file and the rotation, never the
 * token. See `rotateProviderToken` in `@example-app/common`.
 *
 * **The page's routes.** The page lists the user's jobs, starts a run, and
 * stores, lists and deletes the user's secrets, each through this server
 * with the user's token. The browser never reads a secret back. On the local
 * surface no job runs and no vault exists: the platform answers each call with
 * `cloudRequired`, and the page says the feature needs a cloud.
 */

import {
  deleteSecret,
  jobConsentUrl,
  jobRefusal,
  listJobs,
  listSecrets,
  loadAppCredentials,
  putSecret,
  readSecret,
  runJobNow,
  verifyJob,
  type VaultResult,
} from "@starkeep/app-client";
import { mintIdToken } from "@starkeep/app-client/auth";
import { appBasePath } from "@starkeep/app-client/hono";
import {
  APP_ID,
  DIGEST_TAG,
  JOBS,
  LABEL_KEYS,
  SECRETS,
  TABLES,
  digestFileName,
  digestText,
  rotateProviderToken,
  type DigestCounts,
} from "@example-app/common";
import { DataCallError, createExampleFile, dataCaller, type DataCall } from "./data-call.js";

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

/** What one digest run reaches: the run's own vault calls and data calls. */
export interface DigestDeps {
  readSecret(name: string): Promise<VaultResult<string | null>>;
  putSecret(name: string, value: string): Promise<VaultResult<null>>;
  data: DataCall;
  now(): Date;
}

/** How a run ended: 2xx for success, and the message the platform records. */
export interface DigestOutcome {
  status: number;
  message: string;
}

function vaultFailure(what: string, result: VaultResult<unknown>): DigestOutcome {
  const detail = result.ok ? "" : result.cloudRequired ? "the vault needs a cloud" : result.error;
  return { status: 502, message: `${what} failed: ${detail}` };
}

async function count(
  data: DataCall,
  path: string,
  query: Record<string, unknown>,
): Promise<number> {
  const search = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, JSON.stringify(v)]));
  const body = (await data("GET", `${path}?${search}`)) as {
    groups: { n: number | string }[];
  };
  return Number(body.groups[0]?.n ?? 0);
}

/** The counts the digest reports, read with the run's token. */
async function digestCounts(data: DataCall): Promise<DigestCounts> {
  const n = { n: { fn: "count" } };
  const notes = `/app-data/db/${TABLES.notes}`;
  const [files, notesCount, pinned] = await Promise.all([
    count(data, "/data/records", { aggregate: n }),
    count(data, notes, { aggregate: n }),
    count(data, notes, { where: { pinned: { is: true } }, aggregate: n }),
  ]);
  return { files, notes: notesCount, pinned };
}

/** One digest run. Exported for the unit test, which passes fakes. */
export async function runDigest(runId: string, deps: DigestDeps): Promise<DigestOutcome> {
  // Rotate first. A provider that rotates on every use expires the old
  // token as soon as it answers, so the new one must reach the vault before
  // anything else can fail.
  const read = await deps.readSecret(SECRETS.providerToken);
  if (!read.ok) return vaultFailure("Reading the provider token", read);
  let rotation: number | null = null;
  if (read.value !== null) {
    const rotated = rotateProviderToken(read.value);
    const stored = await deps.putSecret(SECRETS.providerToken, rotated.next);
    if (!stored.ok) return vaultFailure("Storing the rotated provider token", stored);
    rotation = rotated.rotation;
  }

  try {
    const at = deps.now();
    const counts = await digestCounts(deps.data);
    const name = digestFileName(at);
    const record = await createExampleFile(
      deps.data,
      name,
      digestText({ at, runId, counts, rotation }),
    );
    await deps.data("POST", "/data/labels", {
      json: { labels: [{ recordId: record.id, key: LABEL_KEYS.tag, value: DIGEST_TAG }] },
    });
    const token =
      rotation === null ? "no provider token stored" : `provider token rotation ${rotation}`;
    return { status: 200, message: `Wrote ${name}; ${token}` };
  } catch (err) {
    if (err instanceof DataCallError) return { status: 502, message: err.message };
    throw err;
  }
}

/** `POST /_starkeep/jobs/digest`: the platform's dispatcher runs the job. */
export async function digestRoute(req: Request): Promise<Response> {
  const run = await verifyJob(req, JOBS.digest);
  if (!run) return jobRefusal();
  const creds = await loadAppCredentials(APP_ID);
  if (!creds)
    return Response.json({ message: `${APP_ID} has no credentials here` }, { status: 503 });
  const caller = { delegation: run.token, creds };
  const outcome = await runDigest(run.runId, {
    readSecret: (name) => readSecret(APP_ID, name, caller),
    putSecret: (name, value) => putSecret(APP_ID, name, value, caller),
    data: dataCaller(creds, run.token),
    now: () => new Date(),
  });
  // The platform records `message` beside the run, on the connections page
  // and in `listJobs`. Any status outside 2xx marks the run failed.
  return Response.json({ message: outcome.message }, { status: outcome.status });
}

// ---------------------------------------------------------------------------
// The page's routes
// ---------------------------------------------------------------------------

const isCloud = () => process.env.STARKEEP_APP_CLIENT_MODE === "cloud";

/**
 * The signed-in user's ID token, which every job and vault call needs in the
 * cloud. Null on the local surface, where the platform answers
 * `cloudRequired`. Undefined when a cloud request carries no live session.
 */
async function userToken(
  req: Request,
): Promise<{ token: string | null; setCookie?: string } | undefined> {
  if (!isCloud()) return { token: null };
  const minted = await mintIdToken(req, APP_ID);
  return minted ? { token: minted.token, setCookie: minted.setCookie } : undefined;
}

/** Run `action` with the user's token, and pass on a re-minted token's cookie. */
async function asUser(
  req: Request,
  action: (userToken: string | null) => Promise<Response>,
): Promise<Response> {
  const user = await userToken(req);
  if (!user) return Response.json({ error: "Sign in first" }, { status: 401 });
  const res = await action(user.token);
  if (user.setCookie) res.headers.append("Set-Cookie", user.setCookie);
  return res;
}

/** A vault write's answer: 501 on the local surface, the vault's status on a refusal. */
function vaultAnswer(result: VaultResult<unknown>): Response {
  if (result.ok) return Response.json(result);
  if (result.cloudRequired) {
    return Response.json({ ...result, error: "The vault needs a cloud" }, { status: 501 });
  }
  return Response.json(result, { status: result.status });
}

/** The longest IANA time zone name is 32 characters; this leaves room. */
const MAX_TIME_ZONE = 64;

/**
 * `GET /api/jobs?tz=<zone>`: the app's jobs and the user's enrollment in
 * each, with a link to the consent page. The link preselects the browser's
 * time zone and returns to this app's page.
 */
export function jobsRoute(req: Request): Promise<Response> {
  return asUser(req, async (token) => {
    const tz = new URL(req.url).searchParams.get("tz") ?? "";
    const timeZone = tz && tz.length <= MAX_TIME_ZONE ? tz : undefined;
    const list = await listJobs(APP_ID, { userToken: token });
    const returnTo = `${appBasePath()}/`;
    return Response.json({
      cloudRequired: list.cloudRequired,
      jobs: list.jobs.map((job) => ({
        ...job,
        consentLink: jobConsentUrl(job, { timeZone, returnTo }),
      })),
    });
  });
}

/** `POST /api/jobs/:name/run`: start one run now, as a scheduled run starts. */
export function runJobRoute(req: Request, name: string): Promise<Response> {
  return asUser(req, async (token) => {
    const result = await runJobNow(APP_ID, name, { userToken: token });
    if (result.ok) return Response.json(result, { status: 202 });
    return Response.json(result, { status: result.cloudRequired ? 501 : result.status });
  });
}

/** `GET /api/vault`: the user's secrets, by name and update time only. */
export function listSecretsRoute(req: Request): Promise<Response> {
  return asUser(req, async (token) => {
    const result = await listSecrets(APP_ID, { userToken: token });
    if (result.ok) return Response.json({ cloudRequired: false, secrets: result.value });
    if (result.cloudRequired) return Response.json({ cloudRequired: true, secrets: [] });
    return Response.json(result, { status: result.status });
  });
}

/** `PUT /api/vault/:name` with `{ value }`: store or replace one secret. */
export function putSecretRoute(req: Request, name: string): Promise<Response> {
  return asUser(req, async (token) => {
    const { value } = (await req.json().catch(() => ({}))) as { value?: unknown };
    if (typeof value !== "string" || value.length === 0) {
      return Response.json({ error: "Send { value } with a non-empty string" }, { status: 400 });
    }
    return vaultAnswer(await putSecret(APP_ID, name, value, { userToken: token }));
  });
}

/** `DELETE /api/vault/:name`: delete one secret. */
export function deleteSecretRoute(req: Request, name: string): Promise<Response> {
  return asUser(req, async (token) =>
    vaultAnswer(await deleteSecret(APP_ID, name, { userToken: token })),
  );
}
