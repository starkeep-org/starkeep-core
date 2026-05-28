/**
 * Run `fn` with retry on AccessDenied. Used to absorb IAM PutRolePolicy
 * propagation delay after Manager attaches a temp-install policy: AWS docs
 * say propagation can take a couple of minutes worst case, and individual
 * (action, resource) pairs propagate independently — so each fresh action
 * needs its own probe before we hand control to whichever downstream
 * subsystem will exercise it.
 *
 * Default budget: 12 attempts, exp backoff capped at 10s → ~90s worst case.
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

export async function retryOnAccessDenied<T>(
  label: string,
  fn: () => Promise<T>,
  opts: RetryOpts = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 12;
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
      if (!isAccessDeniedError(err)) {
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
        `[diag] ${label}: attempt ${attempt} AccessDenied at ${elapsed}s, retrying in ${(delay / 1000).toFixed(1)}s`,
      );
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
  throw new Error(`unreachable: ${label}`);
}
