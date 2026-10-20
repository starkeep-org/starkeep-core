/**
 * The deployment's settings as one host sees them: the document, read through
 * a source and cached, and what that lets the host do.
 *
 * Every host keeps one — both data servers and the phone's embedded node — so
 * the rules below are one implementation rather than three. Here rather than in
 * shared-space-api because the phone links this package and not that one. The
 * document's shape lives in protocol-primitives
 * (`settings/deployment-settings.ts`).
 *
 * ## Where a host reads from
 *
 * The host supplies the source. The cloud reads its SSM parameter. A node with
 * a cloud fetches the Drive channel's settings route. A node without a cloud
 * reads its own config. A source answers the raw document, or null when no
 * document is set, and throws when it cannot answer.
 *
 * ## What a host knows
 *
 * A host knows the deployment's value in three cases:
 *
 * - Its last read returned a document that checks out.
 * - Its last read returned no document. The operator has not set a value, so
 *   the platform's defaults *are* the value and there is nothing to wait for.
 * - No cloud is configured, since then this host is the whole deployment and
 *   its own config, or the defaults, are the value.
 *
 * One case is left: a cloud exists and this host has never read a usable
 * document from it, because every read failed or the document does not check
 * out. Only then is the host in the dark. Such a host records a null stamp,
 * the original waits (`awaiting-stamp`), and the cloud, which always knows,
 * stamps it on the next exchange. Every other host stamps with the value
 * (`stampFor`).
 *
 * A read that fails after a good one keeps the good value. A stamp from the
 * last value read is what a stamping path has always accepted, and an offline
 * laptop has to keep importing.
 *
 * ## The cache
 *
 * A host may keep the last good read in a {@link DeploymentSettingsCache}, so a
 * node that restarts offline still knows the value. The cache holds what the
 * source answered and nothing else.
 *
 * ## Stamping a value, and consuming one
 *
 * The cases above answer "may this host stamp an original", which is what
 * `knowsLibraryValue` reports and what every `standards` reader depends on.
 *
 * The retention window has no stamp. Nothing records "reaped under an unknown
 * window" and corrects it later, so a consumer of the window reads through the
 * source itself — {@link LibrarySettings.acquireRetentionWindow} — rather than
 * trusting the cache. A failed read is an unknown window, whatever the cache
 * holds. "No cloud is configured" is not available to it either: that case
 * says the defaults are the value for stamping, not that this host has read
 * anything.
 *
 * See `~/projects/starkeep/design-settings-read-at-point-of-use-2026-10-07.md`
 * and `~/projects/starkeep/plan-multi-user-roles-2026-10-16.md`, phase 1.
 */

import {
  checkDeploymentSettings,
  DEFAULT_STAND_IN_STANDARDS,
  DEFAULT_TRASH_RETENTION_DAYS,
  retentionDaysFromSettings,
  type DeploymentSettings,
  type StandInStandards,
} from "@starkeep/protocol-primitives";

export interface LibrarySettingsStatus {
  /** Whether the last good read found a document. */
  readonly set: boolean;
  /** The document in force, when the last good read found one. */
  readonly settings: DeploymentSettings | null;
  /**
   * Why the last read failed, or why its document does not check out, as
   * sentences. Empty when the last read succeeded.
   */
  readonly problems: readonly string[];
  /** When the last good read happened, in epoch milliseconds, or null for never. */
  readonly readAt: number | null;
}

/**
 * How long a deleted item stays recoverable, and how long its bytes stay, as
 * one operation read it — or the reasons this host could not read it.
 *
 * An unknown window is not the default window. A reaper in the dark reaps
 * nothing: reaping to a 30-day default under a deployment whose operator chose
 * 365 would destroy bytes the person was promised, and a Trash view that stated
 * a date from the same default would promise something nothing holds to.
 */
export type RetentionWindow =
  | { readonly known: true; readonly days: number }
  | { readonly known: false; readonly problems: readonly string[] };

/** Where a host keeps its last good read. */
export interface DeploymentSettingsCache {
  /** The last document the source answered, or null when it answered none. Undefined: never read. */
  load(): { readonly document: unknown } | undefined;
  save(document: unknown): void;
}

export interface LibrarySettings {
  /** The deployment's stand-in standards: the document's, or the defaults. */
  standards(): StandInStandards;
  /**
   * Read the document through the source, then answer with the retention
   * window the caller may act on. A failed read is unknown.
   */
  acquireRetentionWindow(): Promise<RetentionWindow>;
  /** Whether this host may stamp originals with {@link standards}. */
  knowsLibraryValue(): boolean;
  status(): LibrarySettingsStatus;
  /**
   * Read the document through the source. A failure keeps the last good value
   * and records the reason in {@link status}; it never throws.
   */
  refresh(): Promise<void>;
}

export interface LibrarySettingsOptions {
  /** Answers the raw document, or null when none is set. Throws when it cannot answer. */
  readonly read: () => Promise<unknown>;
  /**
   * Whether this host syncs with a cloud. The cloud itself answers false: it
   * is where the deployment's value is decided, so it always knows it.
   */
  readonly cloudConfigured: () => boolean;
  readonly cache?: DeploymentSettingsCache;
}

interface Loaded {
  readonly settings: DeploymentSettings | null;
  readonly standards: StandInStandards;
}

export function createLibrarySettings(options: LibrarySettingsOptions): LibrarySettings {
  const { read, cloudConfigured, cache } = options;

  let loaded: Loaded | null = null;
  let problems: string[] = [];
  let readAt: number | null = null;

  /** Take one answer from the source. Returns the problems, or none. */
  function accept(document: unknown): string[] {
    if (document === null) {
      loaded = { settings: null, standards: DEFAULT_STAND_IN_STANDARDS };
      return [];
    }
    const checked = checkDeploymentSettings(document);
    if (!checked.ok) {
      // A document that does not check out is not the defaults. Using the
      // defaults would stamp originals against values the operator never chose.
      loaded = null;
      return [...checked.problems];
    }
    loaded = { settings: checked.settings, standards: checked.standards };
    return [];
  }

  const cached = cache?.load();
  if (cached !== undefined) accept(cached.document);

  /** One read through the source. Resolves to the problems, empty on success. */
  async function load(): Promise<string[]> {
    let document: unknown;
    try {
      document = await read();
    } catch (err) {
      problems = [
        `reading the deployment's settings failed: ${err instanceof Error ? err.message : String(err)}`,
      ];
      return problems;
    }
    problems = accept(document);
    if (problems.length === 0) {
      readAt = Date.now();
      try {
        cache?.save(document);
      } catch (err) {
        console.warn("[settings] could not cache the deployment's settings:", err);
      }
    }
    return problems;
  }

  return {
    standards: () => loaded?.standards ?? DEFAULT_STAND_IN_STANDARDS,
    knowsLibraryValue: () => loaded !== null || !cloudConfigured(),
    status: () => ({
      set: loaded?.settings != null,
      settings: loaded?.settings ?? null,
      problems,
      readAt,
    }),
    async refresh() {
      await load();
    },
    async acquireRetentionWindow() {
      const failed = await load();
      if (failed.length > 0 || loaded === null) {
        return {
          known: false,
          problems: failed.length > 0 ? failed : ["the deployment's settings are unreadable"],
        };
      }
      return {
        known: true,
        days: loaded.settings
          ? retentionDaysFromSettings(loaded.settings)
          : DEFAULT_TRASH_RETENTION_DAYS,
      };
    },
  };
}
