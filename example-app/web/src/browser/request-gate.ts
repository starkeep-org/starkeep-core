/**
 * Limits how many requests the page has in flight to its own server, and
 * retries reads that the cloud throttled.
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
 * A throttled read is safe to send again, so the gate retries `GET` and `HEAD`
 * after a 503 or 429. It never retries a write: the gateway also answers 503
 * when the integration times out, and by then the write may already have
 * happened.
 */

/** How many requests the page keeps in flight to its own server at once. */
export const MAX_IN_FLIGHT = 3;

/**
 * The waits before each retry of a throttled read, in milliseconds. Each wait
 * is jittered to between half and one and a half times its value, so requests
 * throttled together do not all return together.
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
   * Run `attempt` once a slot is free, and again after a throttled read. The
   * slot stays held through the retry waits, so a throttled page sends less,
   * not more. A rejected attempt (a network failure) is not retried.
   */
  send<R extends AttemptResult>(method: string, attempt: () => Promise<R>): Promise<R>;
}

/** Whether a response with this status may be sent again for this method. */
export function isRetryableThrottle(method: string, status: number): boolean {
  const read = method === "GET" || method === "HEAD";
  return read && (status === 503 || status === 429);
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
    async send(method, attempt) {
      await acquire();
      try {
        for (let retry = 0; ; retry++) {
          const result = await attempt();
          const delay = options.retryDelaysMs[retry];
          if (delay === undefined || !isRetryableThrottle(method, result.status)) return result;
          await sleep(delay * (0.5 + random()));
        }
      } finally {
        release();
      }
    },
  };
}
