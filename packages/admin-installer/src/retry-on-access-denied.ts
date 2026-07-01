/**
 * Run `fn` with retry on AccessDenied. Used to absorb IAM PutRolePolicy
 * propagation delay after Manager attaches a temp-install policy: AWS docs
 * say propagation can take a couple of minutes worst case, and individual
 * (action, resource) pairs propagate independently — so each fresh action
 * needs its own probe before we hand control to whichever downstream
 * subsystem will exercise it.
 *
 * Default budget: 24 attempts, exp backoff capped at 10s → ~215s worst case.
 * The budget has to actually cover the "couple of minutes" propagation window
 * above: a freshly attached temp policy was observed still not effective at
 * 85s (uninstall's install-infra passphrase read), so a ~90s budget gave up
 * just short of propagation. Backoff means the success path stays fast — the
 * larger ceiling only costs time when an action is genuinely still propagating.
 *
 * AccessDenied is detected across three error shapes we've seen:
 *   - AWS SDK v3:  err.name === "AccessDeniedException" / "AccessDenied"
 *                  or err.message contains "AccessDenied".
 *   - DSQL via pg: the postgres driver surfaces dsql:DbConnectAdmin denial
 *                  as `error: unable to accept connection, access denied`
 *                  with hint `User: ... is not authorized to perform:
 *                  dsql:DbConnectAdmin ...`. Match the lowercase phrase
 *                  and the "not authorized to perform" hint.
 */

interface RetryOpts {
  maxAttempts?: number;
  maxDelayMs?: number;
}

function isAccessDeniedError(err: unknown): boolean {
  const e = err as { name?: string; message?: string; hint?: string };
  const name = e?.name;
  const message = e?.message ?? "";
  const hint = e?.hint ?? "";
  if (name === "AccessDeniedException" || name === "AccessDenied") return true;
  if (message.includes("AccessDenied")) return true;
  if (message.toLowerCase().includes("access denied")) return true;
  if (hint.includes("not authorized to perform")) return true;
  return false;
}

/**
 * Transient DSQL/socket failures that warrant a reconnect-and-retry rather than
 * failing the whole install/uninstall. DSQL connections can stall or drop
 * mid-DDL — observed as a raw `read ETIMEDOUT` on the TLS socket that pg
 * surfaces as an EventEmitter `error` (crashing the process if unhandled) or a
 * rejected query. These are node socket-level `code`s and the pg driver's
 * connection-terminated messages; distinct from AccessDenied (IAM propagation),
 * which has its own retry above.
 */
export function isTransientConnectionError(err: unknown): boolean {
  const e = err as { code?: string; message?: string; errors?: unknown[] };
  const code = e?.code ?? "";
  const message = (e?.message ?? "").toLowerCase();
  const transientCodes = [
    "ETIMEDOUT",
    "ECONNRESET",
    "EPIPE",
    "ECONNREFUSED",
    "ENETUNREACH",
    "ENOTFOUND",
    "EAI_AGAIN",
  ];
  if (transientCodes.includes(code)) return true;
  if (message.includes("connection terminated")) return true;
  if (message.includes("timeout")) return true;
  if (message.includes("etimedout") || message.includes("econnreset")) return true;
  // AggregateError / wrapped socket errors (e.g. happy-eyeballs ETIMEDOUT).
  if (Array.isArray(e?.errors)) return e.errors.some(isTransientConnectionError);
  return false;
}

/**
 * DSQL optimistic-concurrency conflicts. DSQL's catalog is OCC-controlled and
 * some DDL runs partly async (`CREATE INDEX ASYNC`), so overlapping schema
 * changes surface as `schema has been updated by another transaction (OC001)`.
 * AWS's guidance for the OC* class is simply to retry the transaction — safe
 * here because the DDL bodies are idempotent, so a replay converges. Observed
 * intermittently on per-app install DDL in the Tier-3 e2e.
 */
export function isRetryableDsqlConflict(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  const code = e?.code ?? "";
  const message = (e?.message ?? "").toLowerCase();
  if (code.startsWith("OC")) return true; // DSQL OCC conflict family (e.g. OC000/OC001)
  if (message.includes("updated by another transaction")) return true;
  if (message.includes("change conflicts with another transaction")) return true;
  return false;
}

/**
 * Core retry loop: retry `fn` while `shouldRetry(err)` holds, with exponential
 * backoff. `retryOnAccessDenied` and `retryOnTransientDbError` are thin wrappers
 * that fix the predicate (and the diagnostic label prefix) for their case.
 */
async function retryWhile<T>(
  label: string,
  kind: string,
  shouldRetry: (err: unknown) => boolean,
  fn: () => Promise<T>,
  opts: RetryOpts,
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 24;
  const maxDelayMs = opts.maxDelayMs ?? 10_000;
  let delay = 1000;
  const start = Date.now();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      if (attempt > 1) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`[diag] ${label}: succeeded on attempt ${attempt} after ${elapsed}s`);
      }
      return result;
    } catch (err) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      if (!shouldRetry(err)) {
        const name = (err as { name?: string })?.name;
        console.log(
          `[diag] ${label}: attempt ${attempt} non-retryable error after ${elapsed}s: ${name ?? "?"}`,
        );
        throw err;
      }
      if (attempt === maxAttempts) {
        console.log(`[diag] ${label}: gave up after ${attempt} attempts / ${elapsed}s`);
        throw err;
      }
      console.log(
        `[diag] ${label}: attempt ${attempt} ${kind} at ${elapsed}s, retrying in ${(delay / 1000).toFixed(1)}s`,
      );
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
  throw new Error(`unreachable: ${label}`);
}

export async function retryOnAccessDenied<T>(
  label: string,
  fn: () => Promise<T>,
  opts: RetryOpts = {},
): Promise<T> {
  return retryWhile(label, "AccessDenied", isAccessDeniedError, fn, opts);
}

/**
 * Retry `fn` on transient DSQL failures — socket drops/timeouts AND DSQL OCC
 * conflicts — reconnecting from scratch each attempt. Callers must make `fn`
 * self-contained (open its own connection, run its statements, close) and
 * idempotent, since a mid-run failure replays the whole body. Budget is short
 * by default — these clear in seconds; a persistent failure should surface,
 * not spin.
 */
export async function retryOnTransientDbError<T>(
  label: string,
  fn: () => Promise<T>,
  opts: RetryOpts = {},
): Promise<T> {
  return retryWhile(
    label,
    "transient-db-error",
    (err) => isTransientConnectionError(err) || isRetryableDsqlConflict(err),
    fn,
    {
      maxAttempts: opts.maxAttempts ?? 5,
      maxDelayMs: opts.maxDelayMs ?? 5_000,
    },
  );
}
