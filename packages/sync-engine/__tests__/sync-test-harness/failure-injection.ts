import type {
  GetResult,
  ListOptions,
  ListResult,
  ObjectFacts,
  ObjectStorageAdapter,
  PutOptions,
  PutStreamOptions,
} from "@starkeep/storage-adapter";
import type {
  AppSyncableRowEntry,
  ScanCapableApplier,
  SyncExchangeRequest,
  SyncExchangeResponse,
  SyncTransport,
} from "../../src/types.js";

/**
 * Predicate over an object-storage `put` call. The harness pre-resolves
 * `BlobTarget` values like `"middle"` to concrete keys before installing rules,
 * so the predicate just needs to recognize matching keys.
 */
export interface PutFailRule {
  /** Returns true when this rule should fail the put. */
  matches(key: string): boolean;
  /** transient = fail once per matching key, then succeed; persistent = always fail. */
  recov: "transient" | "persistent";
  /** Internal — tracks which keys have already absorbed their one transient failure. */
  firedFor: Set<string>;
  label: string;
}

/**
 * `ObjectStorageAdapter` wrapper that selectively fails `put` calls based on
 * installed rules. `get`/`has`/`list`/`delete` pass through unchanged — failure
 * for `transferFile` is triggered at the destination's `put`, which is enough
 * to cover both blob-upload-fails (wrap remote storage) and blob-download-fails
 * (wrap local storage).
 *
 * Multiple rules may be installed; the first match wins.
 */
export class FailingObjectStorageAdapter implements ObjectStorageAdapter {
  private rules: PutFailRule[] = [];

  constructor(private readonly base: ObjectStorageAdapter) {}

  installRule(rule: Omit<PutFailRule, "firedFor">): void {
    this.rules.push({ ...rule, firedFor: new Set() });
  }

  clearRules(): void {
    this.rules = [];
  }

  init(): Promise<void> {
    return this.base.init();
  }

  close(): Promise<void> {
    return this.base.close();
  }

  healthCheck(): Promise<boolean> {
    return this.base.healthCheck();
  }

  async put(key: string, data: Uint8Array, options?: PutOptions): Promise<void> {
    for (const rule of this.rules) {
      if (!rule.matches(key)) continue;
      const shouldFail = rule.recov === "persistent" || !rule.firedFor.has(key);
      if (shouldFail) {
        rule.firedFor.add(key);
        throw new Error(
          `[harness] injected put failure (${rule.label}) for key: ${key}`,
        );
      }
    }
    await this.base.put(key, data, options);
  }

  get(key: string): Promise<GetResult | null> {
    return this.base.get(key);
  }

  getStream(key: string): Promise<ReadableStream<Uint8Array> | null> {
    return this.base.getStream(key);
  }

  // Failure is injected on the *destination* write, so putStream has to honour
  // the same rules as put — the transfer path uses streams now, and a rule that
  // only fired on put() would silently stop injecting anything.
  async putStream(
    key: string,
    body: ReadableStream<Uint8Array>,
    options?: PutStreamOptions,
  ): Promise<void> {
    for (const rule of this.rules) {
      if (!rule.matches(key)) continue;
      const shouldFail = rule.recov === "persistent" || !rule.firedFor.has(key);
      if (shouldFail) {
        rule.firedFor.add(key);
        // Cancel rather than leak: an abandoned stream keeps the source's
        // connection open, and the retry on the next round would then contend
        // with it.
        await body.cancel().catch(() => {});
        throw new Error(
          `[harness] injected putStream failure (${rule.label}) for key: ${key}`,
        );
      }
    }
    await this.base.putStream(key, body, options);
  }

  has(key: string): Promise<boolean> {
    return this.base.has(key);
  }

  stat(key: string): Promise<ObjectFacts | null> {
    return this.base.stat(key);
  }

  restoreObject(
    key: string,
    options: { tier: string; days: number },
  ): Promise<"started" | "already-in-progress"> {
    return this.base.restoreObject(key, options);
  }

  setTags(key: string, tags: Record<string, string>): Promise<void> {
    return this.base.setTags(key, tags);
  }

  delete(key: string): Promise<void> {
    return this.base.delete(key);
  }

  list(prefix: string, options?: ListOptions): Promise<ListResult> {
    return this.base.list(prefix, options);
  }
}

/**
 * Make one method of an adapter fail, leaving the rest of it alone.
 *
 * Blob writes were for a long time the only failure this harness could inject,
 * and that shaped what the suite could see: every test that needed "something
 * went wrong" reached for a `put`, so the paths guarding a failed *scan*, a
 * failed *watermark read*, a failed *row write* and a lost *response* were
 * never entered by any test. Two of the review findings lived in exactly there
 * — an applier that swallowed a scan error and reported "enumerated
 * everything", and a round that called a failed shipment complete.
 *
 * A proxy rather than a hand-written wrapper class per adapter: these
 * interfaces are wide (`ObjectStorageAdapter` alone is a dozen methods) and a
 * wrapper that has to be extended every time one grows is a wrapper that
 * silently stops forwarding. Only the named method changes behaviour.
 *
 * `failFor` bounds how many calls fail, so a test can make something fail once
 * and then observe the recovery — the difference between "this round is safe"
 * and "this channel is stuck forever".
 */
export function failingMethod<T extends object>(
  base: T,
  method: keyof T & string,
  options: { readonly message?: string; readonly failFor?: number } = {},
): T {
  const message = options.message ?? `[harness] injected ${method} failure`;
  let remaining = options.failFor ?? Number.POSITIVE_INFINITY;
  const proxy = new Proxy(base, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (prop === method) {
        return (...args: unknown[]) => {
          if (remaining > 0) {
            remaining -= 1;
            return Promise.reject(new Error(message));
          }
          return (value as (...a: unknown[]) => unknown).apply(proxy, args);
        };
      }
      // Bound to the *proxy*, not to the base, so an internal `this.foo()` call
      // sees the injection too. That is not a detail: both real appliers reach
      // their watermark read as `this.getNodeWatermarks(...)` from inside
      // `scanSince`, and an injection that only caught direct calls would test
      // a shape no production caller has.
      return (...args: unknown[]) =>
        (value as (...a: unknown[]) => unknown).apply(proxy, args);
    },
  }) as T;
  return proxy;
}

/**
 * Fail only the method the *caller* invokes, leaving the object's own internal
 * use of it working.
 *
 * The counterpart to {@link failingMethod}, and the distinction matters more
 * than it looks. `failingMethod` binds to the proxy so an internal `this.foo()`
 * sees the injection too, which is right when the question is "what does this
 * adapter do when its own read fails" — both real appliers reach their
 * watermark read from inside `scanSince`, so breaking one breaks both, exactly
 * as production would.
 *
 * It is wrong when the question is about a *caller* that makes two independent
 * calls and only one of them fails. The responder's coverage report is that
 * case: `getNodeWatermarks` is what computes the report, `scanSince` is what
 * produces the rows to ship, and R12 is specifically about a responder that
 * still hands over rows while being unable to say what it holds. Breaking both
 * describes a different, less interesting fault — a table that is simply gone —
 * and it hides the finding, because a responder that ships nothing gives the
 * requester nothing to re-ship.
 */
export function failingDirectMethod<T extends object>(
  base: T,
  method: keyof T & string,
  options: { readonly message?: string; readonly failFor?: number } = {},
): T {
  const message = options.message ?? `[harness] injected ${method} failure`;
  let remaining = options.failFor ?? Number.POSITIVE_INFINITY;
  return new Proxy(base, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (prop === method) {
        return (...args: unknown[]) => {
          if (remaining > 0) {
            remaining -= 1;
            return Promise.reject(new Error(message));
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      // Bound to the base, so the object's internal calls are untouched.
      return (...args: unknown[]) =>
        (value as (...a: unknown[]) => unknown).apply(target, args);
    },
  }) as T;
}

/**
 * Make the **peer** fail, rather than this side.
 *
 * The requester-side injection above was built first and it left the suite
 * lopsided: every "something went wrong" case in it happened on the node under
 * test, so nothing ever exercised a round the *responder* discarded. That is a
 * different failure with a different shape — every local signal reports a clean
 * round — and two of the highest-value findings lived exactly there: a round the
 * peer dropped entirely reported `complete: true`, and a repair floor retired
 * against a repair that filled nothing.
 *
 * Wrapping the applier rather than the transport is deliberate: the responder's
 * halt logic (stop this author on its first failed apply, skip the rest, leave
 * the coverage watermark behind the row) is the thing under test, so the failure
 * has to be injected *underneath* it and the real transport has to react.
 *
 * `shouldFail` receives each entry, so one author can be made to fail while
 * another succeeds — which is what makes the per-author halt observable rather
 * than merely asserted.
 */
export function failingApplier(
  base: ScanCapableApplier,
  shouldFail: (entry: AppSyncableRowEntry) => boolean,
): ScanCapableApplier {
  return {
    ...base,
    async apply(entry) {
      if (shouldFail(entry)) {
        throw new Error(
          `[harness] injected responder apply failure for ${entry.appId}.${entry.table} ${String(entry.row?.["id"] ?? "")}`,
        );
      }
      return base.apply(entry);
    },
  };
}

/**
 * A transport whose response is lost *after* the responder has applied it.
 *
 * Not the same failure as an unreachable peer, and the difference is the whole
 * point: the peer's state moved and the caller's did not. The caller's cached
 * `peerWatermarks` are now stale-low, so a round that pushed against them would
 * re-ship everything the peer already holds. It is the case the pull-first
 * round exists to absorb.
 */
export function losingResponseTransport(
  base: SyncTransport,
  options: { readonly loseFor?: number } = {},
): SyncTransport {
  let remaining = options.loseFor ?? 1;
  return {
    async exchange(request: SyncExchangeRequest): Promise<SyncExchangeResponse> {
      const response = await base.exchange(request);
      if (remaining > 0) {
        remaining -= 1;
        throw new Error("[harness] response lost in transit after the peer applied it");
      }
      return response;
    },
  };
}

/**
 * Resolve a `BlobTarget` selector against a known set of candidate keys (in
 * the order they will be processed by the engine) to a concrete predicate.
 * `"all"` → match every key; `"first"`/`"middle"`/`"last"` → resolve to that
 * key by position; `{index}` → resolve by index; `{id}` → match by id-derived
 * key (caller provides the resolver).
 */
export function buildKeyMatcher(
  target:
    | "all"
    | "first"
    | "middle"
    | "last"
    | { index: number }
    | { id: string },
  candidateKeys: readonly string[],
  resolveIdToKey?: (id: string) => string | undefined,
): (key: string) => boolean {
  if (target === "all") return () => true;

  let matchKey: string | undefined;
  if (target === "first") matchKey = candidateKeys[0];
  else if (target === "last") matchKey = candidateKeys[candidateKeys.length - 1];
  else if (target === "middle")
    matchKey = candidateKeys[Math.floor((candidateKeys.length - 1) / 2)];
  else if ("index" in target) matchKey = candidateKeys[target.index];
  else if ("id" in target) matchKey = resolveIdToKey?.(target.id);

  if (!matchKey) {
    throw new Error(
      `[harness] cannot resolve blob-failure target ${JSON.stringify(target)} — candidate set has ${candidateKeys.length} keys`,
    );
  }
  const resolved = matchKey;
  return (key: string) => key === resolved;
}
