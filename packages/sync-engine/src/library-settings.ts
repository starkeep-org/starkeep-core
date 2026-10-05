/**
 * The library's settings as one host sees them: the winning settings file,
 * read once and cached, and what that lets the host do.
 *
 * Every host keeps one — both data servers and the phone's embedded node — so
 * the rules below are one implementation rather than three. Here rather than in
 * shared-space-api because the phone links this package and not that one. The
 * file format and the winner rule live in protocol-primitives
 * (`settings/user-settings.ts`).
 *
 * ## What a host knows
 *
 * A host knows the library's value in three cases:
 *
 * - It holds the winning settings file's bytes and they parse.
 * - No live settings file exists at all. The person has not set a value, so
 *   the platform's defaults *are* the library's value and there is nothing to
 *   wait for. A later file overrides the defaults for originals stamped after
 *   it arrives, which is what the stamp is for.
 * - No cloud is configured, since then this host is the whole library and its
 *   own file, or the defaults, are the value.
 *
 * One case is left: a live settings file exists and this host cannot use it,
 * because the bytes have not arrived or do not parse. Only then is the host in
 * the dark. Such a host records a null stamp, the original waits
 * (`awaiting-stamp`), and the cloud, which always knows, stamps it on the next
 * exchange. Every other host stamps with the value (`stampFor`).
 *
 * Telling "no file" from "a file I cannot read" matters because the stamp is
 * the only threshold any rule reads (`thresholdOf`). Treating a fresh library
 * as unknown would leave every original in a library whose owner never touched
 * the setting waiting on the cloud before any app could derive a stand-in.
 */

import {
  DEFAULT_STAND_IN_STANDARDS,
  parseUserSettings,
  pickSettingsRecord,
  SETTINGS_TYPE_ID,
  type DataRecord,
  type HLCClock,
  type StandInStandards,
  type StarkeepId,
  type UserSettings,
} from "@starkeep/protocol-primitives";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";

/** Upper bound on live settings records; far above anything concurrent edits leave. */
const MAX_SETTINGS_RECORDS = 50;

export interface LibrarySettingsStatus {
  /** Whether the person has set a value: a live settings record exists. */
  readonly set: boolean;
  /** The winning settings record, when there is one. */
  readonly recordId: string | null;
  /** The winning file's contents, when its bytes are here and parse. */
  readonly settings: UserSettings | null;
  /**
   * Why the winning file cannot be used, as sentences: bytes not here yet, or
   * contents that do not parse. Empty when the file is in force or absent.
   */
  readonly problems: readonly string[];
}

export interface LibrarySettings {
  /** The library's stand-in standards: the settings file's, or the defaults. */
  standards(): StandInStandards;
  /** Whether this host may stamp originals with {@link standards}. */
  knowsLibraryValue(): boolean;
  status(): LibrarySettingsStatus;
  /**
   * Re-read the settings records, tombstone every live one but the winner, and
   * reload the winner's bytes when the winner changed or was unreadable.
   * Returns the tombstones written.
   *
   * `io` replaces the adapters the source was built with, for a host that
   * builds its adapters per request but keeps one source — the cloud's
   * Lambda, whose cache then outlives the request. `tombstoneLosers: false`
   * leaves losing files alone, for a caller whose identity may not write them.
   */
  refresh(io?: Partial<LibrarySettingsIo> & { readonly tombstoneLosers?: boolean }): Promise<DataRecord[]>;
}

/** What a refresh reads and writes through. */
export interface LibrarySettingsIo {
  readonly db: DatabaseAdapter;
  readonly storage: Pick<ObjectStorageAdapter, "get">;
  readonly clock: HLCClock;
}

export interface LibrarySettingsOptions extends Partial<LibrarySettingsIo> {
  /**
   * Whether this host syncs with a cloud. The cloud itself answers false: it
   * is where the library's value is decided, so it always knows it.
   */
  readonly cloudConfigured: () => boolean;
}

export function createLibrarySettings(options: LibrarySettingsOptions): LibrarySettings {
  const { cloudConfigured } = options;

  let winnerId: StarkeepId | null = null;
  let loaded: { settings: UserSettings; standards: StandInStandards } | null = null;
  let problems: string[] = [];

  return {
    standards: () => loaded?.standards ?? DEFAULT_STAND_IN_STANDARDS,
    // `winnerId !== null && loaded === null` is the one state that means "a
    // settings file exists and this host cannot use it".
    knowsLibraryValue: () => loaded !== null || winnerId === null || !cloudConfigured(),
    status: () => ({
      set: winnerId !== null,
      recordId: winnerId,
      settings: loaded?.settings ?? null,
      problems,
    }),

    async refresh(io = {}) {
      const db = io.db ?? options.db;
      const storage = io.storage ?? options.storage;
      const clock = io.clock ?? options.clock;
      if (!db || !storage || !clock) throw new Error("library settings: no adapters to refresh through");
      const result = await db.query({
        filters: [
          { field: "type", operator: "eq", value: SETTINGS_TYPE_ID },
          { field: "deletedAt", operator: "isNull" },
        ],
        limit: MAX_SETTINGS_RECORDS,
      });
      const { winner, losers } = pickSettingsRecord(result.records);

      // Every host tombstones the losers the same way, so concurrent edits on
      // two offline desktops converge on one live settings record.
      const tombstones: DataRecord[] = [];
      for (const loser of io.tombstoneLosers === false ? [] : losers) {
        const hlc = clock.now();
        await db.delete(loser.id as StarkeepId, hlc);
        tombstones.push({ ...loser, deletedAt: hlc, updatedAt: hlc, version: loser.version + 1 });
      }

      if (!winner) {
        winnerId = null;
        loaded = null;
        problems = [];
        return tombstones;
      }
      if (winner.id === winnerId && loaded !== null) return tombstones;

      winnerId = winner.id as StarkeepId;
      loaded = null;
      const bytes = winner.objectStorageKey ? await storage.get(winner.objectStorageKey) : null;
      if (!bytes) {
        problems = ["the settings file's bytes have not reached this machine yet"];
        return tombstones;
      }
      const parsed = parseUserSettings(bytes.data);
      if (parsed.ok) {
        loaded = { settings: parsed.settings, standards: parsed.standards };
        problems = [];
      } else {
        problems = [...parsed.problems];
      }
      return tombstones;
    },
  };
}
