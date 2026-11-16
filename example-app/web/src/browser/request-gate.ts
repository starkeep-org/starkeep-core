/**
 * Limits how many requests the page has in flight to its own server, and
 * retries requests that the cloud throttled.
 *
 * In the cloud, each request to the app's server runs one invocation of the
 * app's Lambda, which forwards it to the data server's Lambda. A request
 * therefore holds two concurrent Lambda executions, and the account's limit on
 * concurrent executions covers every app and the sync traffic too. A refresh
 * of every panel issues about fifteen requests. Sent all at once, they need
 * about thirty executions, and the gateway answers each one over the limit
 * with a 503. The page then fails to load. Requests queued behind a small
 * limit finish a little later instead of failing.
 *
 * A 503 or 429 means the work never started, so the gate sends the request
 * again, write or read. The gateway answers 503 when Lambda refuses the
 * invocation, and the proxy passes the data server's own throttle through
 * unchanged. The data server's and the proxy's deliberate 503s are refusals
 * made before any work. The gate never retries a 500, 502 or 504: those can
 * follow a crash or a timeout after a write already happened.
 */

/** How many requests the page keeps in flight to its own server at once. */
export const MAX_IN_FLIGHT = 3;

/**
 * The waits before each retry of a throttled request, in milliseconds. Each
 * wait is jittered to between half and one and a half times its value, so
 * requests throttled together do not all return together.
 */
export const RETRY_DELAYS_MS: readonly number[] = [300, 1000, 3000];

export interface RequestGateOptions {
  readonly maxInFlight: number;
  readonly retryDelaysMs: readonly number[];
  /** Injectable for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests. Answers a number in [0, 1). */
  readonly random?: () => number;
}

/** What the gate needs to know about one attempt's outcome. */
export interface AttemptResult {
  readonly status: number;
}

export interface RequestGate {
  /**
   * Run `attempt` once a slot is free, and again after a throttle. The slot
   * stays held through the retry waits, so a throttled page sends less, not
   * more. A rejected attempt (a network failure) is not retried, because the
   * request may have arrived.
   */
  send<R extends AttemptResult>(attempt: () => Promise<R>): Promise<R>;
}

/** Whether a response with this status means the work never started. */
export function isThrottle(status: number): boolean {
  return status === 503 || status === 429;
}

export function createRequestGate(options: RequestGateOptions): RequestGate {
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const random = options.random ?? Math.random;
  let active = 0;
  const waiting: Array<() => void> = [];

  const acquire = async (): Promise<void> => {
    if (active < options.maxInFlight) {
      active++;
      return;
    }
    // `release` hands its slot straight to the next waiter, so `active` stays
    // the same and no newcomer can take the slot first.
    await new Promise<void>((resolve) => waiting.push(resolve));
  };

  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };

  return {
    async send(attempt) {
      await acquire();
      try {
        for (let retry = 0; ; retry++) {
          const result = await attempt();
          const delay = options.retryDelaysMs[retry];
          if (delay === undefined || !isThrottle(result.status)) return result;
          await sleep(delay * (0.5 + random()));
        }
      } finally {
        release();
      }
    },
  };
}
