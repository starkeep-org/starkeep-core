/**
 * The example's background jobs, `digest` and `keywords`, and the page's job
 * and vault routes.
 *
 * **The jobs.** The manifest declares both jobs, which the platform runs in
 * the cloud for each user who turns them on, at the user's time of day or when
 * the user clicks Run now. The platform's dispatcher calls
 * `POST /_starkeep/jobs/<name>` with a `job` token and no session cookie, so
 * `app.ts` mounts the routes ahead of the origin gate. `verifyJob` checks the
 * token, and every call the run makes forwards it, so the platform applies
 * the job's mode and the user's grant to each one.
 *
 * Each `digest` run plays a sync from a third-party service. It reads the user's
 * provider token from the vault, rotates it as such a provider would, and
 * writes the next value back before the run ends. It then counts the user's
 * example files and notes, and saves the counts as a new example file tagged
 * `digest`. The run's message names the file and the rotation, never the
 * token. See `rotateProviderToken` in `@example-app/common`.
 *
 * Each `keywords` run processes the user's files one by one, as an OCR or
 * classification job would. It reads the text of each example file it has not
 * read before and labels the file with the keywords in it. The job runs in
 * `read` mode, which reads everything and writes labels only. See
 * `runKeywords` below.
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
  keywordsOf,
  SECRETS,
  TABLES,
  digestFileName,
  digestText,
  rotateProviderToken,
  type DigestCounts,
} from "@example-app/common";
import {
  DataCallError,
  createExampleFile,
  dataCaller,
  type DataCall,
  type RecordRow,
} from "./data-call.js";

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

/** How a run of either job ended: 2xx for success, and the message the platform records. */
export interface JobOutcome {
  status: number;
  message: string;
}

function vaultFailure(what: string, result: VaultResult<unknown>): JobOutcome {
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
export async function runDigest(runId: string, deps: DigestDeps): Promise<JobOutcome> {
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

/** What one keywords run reaches: its data calls, and a fetch of a file's text. */
export interface KeywordsDeps {
  data: DataCall;
  /** The text at a signed file URL. Throws a {@link DataCallError} when the fetch fails. */
  fetchText(url: string): Promise<string>;
}

/** The most files one run reads, so a run stays within the handler's timeout. */
export const KEYWORDS_BATCH = 25;

/** How many file texts a run fetches at once. */
const FETCH_AT_ONCE = 10;

/**
 * One keywords run. Exported for the unit test, which passes fakes.
 *
 * The run picks up only files without the `indexed` flag, oldest first, and
 * flags each file it reads. A user with many files therefore gets them all
 * labelled over several runs, and a run never reads a file twice. The flag,
 * not the keywords, marks a file as read, because a file may have no
 * keywords.
 *
 * A file whose bytes are still uploading, or whose text cannot be fetched,
 * keeps no flag. The run reports it, and the next run tries it again. A file
 * the cloud will never serve bytes for gets the flag and no keywords, so it
 * never holds a place in the oldest-first batch.
 */
export async function runKeywords(deps: KeywordsDeps): Promise<JobOutcome> {
  try {
    const search = new URLSearchParams({
      notLabel: `${APP_ID}/${LABEL_KEYS.indexed}`,
      order: JSON.stringify([{ col: "created_at", dir: "asc" }]),
      limit: String(KEYWORDS_BATCH),
    });
    const listed = (await deps.data("GET", `/data/records?${search}`)) as {
      records: RecordRow[];
      nextCursor?: string | null;
    };
    const ids = listed.records.map((r) => r.id);
    if (ids.length === 0) return { status: 200, message: "No new files" };

    const { urls, awaitingUpload } = (await deps.data("POST", "/data/records/file-urls", {
      json: { ids },
    })) as { urls: Record<string, { url: string } | undefined>; awaitingUpload?: string[] };
    // An id the data server neither signed nor named in `awaitingUpload` has
    // no bytes the cloud will ever serve, so the run counts it as read with
    // no keywords. An id in `awaitingUpload` waits for its upload.
    const later = new Set(awaitingUpload ?? []);
    const noBytes = ids.filter((id) => !urls[id] && !later.has(id));
    const found = new Map<string, string[]>(noBytes.map((id) => [id, []]));
    for (let i = 0; i < ids.length; i += FETCH_AT_ONCE) {
      await Promise.all(
        ids.slice(i, i + FETCH_AT_ONCE).map(async (id) => {
          const url = urls[id]?.url;
          if (!url) return;
          try {
            found.set(id, keywordsOf(await deps.fetchText(url)));
          } catch (err) {
            if (!(err instanceof DataCallError)) throw err;
          }
        }),
      );
    }

    const read = ids.filter((id) => found.has(id));
    if (read.length > 0) {
      // `/data/labels/values` makes the key hold exactly these keywords, so a
      // second labelling replaces the first rather than adding to it.
      await deps.data("POST", "/data/labels/values", {
        json: {
          labels: read.map((recordId) => ({
            recordId,
            key: LABEL_KEYS.keyword,
            values: found.get(recordId),
          })),
        },
      });
      await deps.data("POST", "/data/labels", {
        json: { labels: read.map((recordId) => ({ recordId, key: LABEL_KEYS.indexed })) },
      });
    }

    const fetched = read.length - noBytes.length;
    const parts = [`Read ${fetched} ${fetched === 1 ? "file" : "files"}`];
    if (noBytes.length > 0) {
      parts.push(`${noBytes.length} ${noBytes.length === 1 ? "has" : "have"} no bytes to read`);
    }
    const unread = ids.length - read.length;
    if (unread > 0) parts.push(`${unread} could not be read`);
    parts.push(listed.nextCursor ? "more remain for the next run" : "none left");
    return { status: 200, message: parts.join("; ") };
  } catch (err) {
    if (err instanceof DataCallError) return { status: 502, message: err.message };
    throw err;
  }
}

/**
 * A file's text at a signed URL. Every failure, a refusal or a network
 * error, throws a {@link DataCallError}, so the run skips only that file.
 * Exported for the unit test.
 */
export async function fetchText(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new DataCallError(0, `A file's text could not be fetched: ${(err as Error).message}`);
  }
  if (!res.ok) throw new DataCallError(res.status, `A file's text answered ${res.status}`);
  return await res.text();
}

/** `POST /_starkeep/jobs/keywords`: the platform's dispatcher runs the job. */
export async function keywordsRoute(req: Request): Promise<Response> {
  const run = await verifyJob(req, JOBS.keywords);
  if (!run) return jobRefusal();
  const creds = await loadAppCredentials(APP_ID);
  if (!creds)
    return Response.json({ message: `${APP_ID} has no credentials here` }, { status: 503 });
  const outcome = await runKeywords({ data: dataCaller(creds, run.token), fetchText });
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
