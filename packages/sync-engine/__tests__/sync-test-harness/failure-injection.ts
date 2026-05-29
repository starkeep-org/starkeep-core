import type {
  GetResult,
  ListOptions,
  ListResult,
  ObjectStorageAdapter,
  PutOptions,
} from "@starkeep/storage-adapter";

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

  has(key: string): Promise<boolean> {
    return this.base.has(key);
  }

  delete(key: string): Promise<void> {
    return this.base.delete(key);
  }

  list(prefix: string, options?: ListOptions): Promise<ListResult> {
    return this.base.list(prefix, options);
  }
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
