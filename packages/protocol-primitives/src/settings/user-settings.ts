/**
 * The library's settings file: what the person chose for the whole library,
 * kept as an ordinary shared record so it syncs to every node and the cloud
 * over the Drive channel like any other file.
 *
 * ## Why a file rather than a register on the wire
 *
 * A setting every node must agree on needs a home that replicates. The Drive
 * channel already replicates shared records, their bytes, and their
 * tombstones, to every node and the phone. A file on that path needs no wire
 * field, no table and no grant — and the person can see it in Drive.
 *
 * ## The rules
 *
 * - **Type.** `starkeep/settings`, in the Drive-only `starkeep` category. No
 *   installable app can read or rewrite it, and no extension maps to it, so
 *   only the platform assigns it. A same-named file ingested by extension is
 *   `text/json`, and the platform ignores it.
 * - **Absence.** No file exists until the person sets a value, and a missing
 *   file means the platform defaults. Defaults never count as a write, so a new
 *   node cannot overwrite the person's choice with defaults.
 * - **Edits.** A record's bytes never change, so an edit writes a new settings
 *   record and tombstones the previous one.
 * - **Concurrent edits.** The live settings record with the newest `createdAt`
 *   wins everywhere, and a node holding more than one tombstones the rest.
 *   Concurrent tombstones of the same losers converge.
 *
 * See `~/projects/starkeep/plan-canonical-stand-in-setting-2026-09-30.md`,
 * plan choice 4.
 */

import { compareHLC } from "../hlc/compare.js";
import type { DataRecord } from "../records/types.js";
import {
  DEFAULT_STAND_IN_STANDARDS,
  validateStandInStandards,
  type CategoryStandards,
  type StandInStandards,
} from "../stand-ins/standards.js";
import { SETTINGS_TYPE_ID } from "../types/core-types.js";

/** The settings file's name, as Drive shows it. */
export const USER_SETTINGS_FILE_NAME = "starkeep-user-settings.json";

/** The MIME type the settings file is stored and served as. */
export const USER_SETTINGS_MIME_TYPE = "application/json";

/**
 * The file's contents. Every field is optional: an absent one takes the
 * platform's default, so a file written by an older build keeps its meaning
 * when a newer build adds a setting.
 */
export interface UserSettings {
  readonly standIns?: {
    readonly image?: { readonly canonicalThreshold?: number };
    readonly video?: {
      readonly canonicalThreshold?: number;
      /** Keyed `canonical` and by standard size; see `AdvisoryLongEdges`. */
      readonly advisoryLongEdges?: {
        readonly canonical?: number;
        readonly bySize?: Readonly<Record<string, number>>;
      };
    };
  };
}

/** The library's stand-in standards under a settings file. */
export function standardsFromSettings(
  settings: UserSettings,
  defaults: StandInStandards = DEFAULT_STAND_IN_STANDARDS,
): StandInStandards {
  const image = settings.standIns?.image;
  const video = settings.standIns?.video;
  const edges = video?.advisoryLongEdges;
  const defaultEdges = defaults.video.advisoryLongEdges;
  const bySize: Record<number, number> = { ...(defaultEdges?.bySize ?? {}) };
  for (const [size, edge] of Object.entries(edges?.bySize ?? {})) bySize[Number(size)] = edge;
  const videoStandards: CategoryStandards = {
    ...defaults.video,
    canonicalThreshold: video?.canonicalThreshold ?? defaults.video.canonicalThreshold,
    advisoryLongEdges: defaultEdges
      ? { canonical: edges?.canonical ?? defaultEdges.canonical, bySize }
      : null,
  };
  return {
    image: {
      ...defaults.image,
      canonicalThreshold: image?.canonicalThreshold ?? defaults.image.canonicalThreshold,
    },
    video: videoStandards,
  };
}

/**
 * The settings a set of standards amounts to, written out whole: every value
 * the file can hold, so the file states what the person saw when they saved.
 */
export function settingsFromStandards(standards: StandInStandards): UserSettings {
  const edges = standards.video.advisoryLongEdges;
  return {
    standIns: {
      image: { canonicalThreshold: standards.image.canonicalThreshold },
      video: {
        canonicalThreshold: standards.video.canonicalThreshold,
        ...(edges
          ? {
              advisoryLongEdges: {
                canonical: edges.canonical,
                bySize: Object.fromEntries(Object.entries(edges.bySize).map(([k, v]) => [k, v])),
              },
            }
          : {}),
      },
    },
  };
}

export type UserSettingsCheck =
  | { readonly ok: true; readonly settings: UserSettings; readonly standards: StandInStandards }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Check a parsed settings value: its shape, and the standards it amounts to.
 * Unknown fields are ignored, so a newer build's file still reads here.
 */
export function checkUserSettings(value: unknown): UserSettingsCheck {
  const problems: string[] = [];
  if (!isObject(value)) return { ok: false, problems: ["the settings must be a JSON object"] };
  const standIns = value["standIns"];
  if (standIns !== undefined && !isObject(standIns)) problems.push("standIns must be an object");
  const categories = isObject(standIns) ? standIns : {};
  for (const category of ["image", "video"] as const) {
    const entry = categories[category];
    if (entry === undefined) continue;
    if (!isObject(entry)) {
      problems.push(`standIns.${category} must be an object`);
      continue;
    }
    const threshold = entry["canonicalThreshold"];
    if (threshold !== undefined && !isPositiveInteger(threshold)) {
      problems.push(`standIns.${category}.canonicalThreshold must be a positive whole number`);
    }
  }
  const video = categories["video"];
  const edges = isObject(video) ? video["advisoryLongEdges"] : undefined;
  if (edges !== undefined) {
    if (!isObject(edges)) {
      problems.push("standIns.video.advisoryLongEdges must be an object");
    } else {
      if (edges["canonical"] !== undefined && !isPositiveInteger(edges["canonical"])) {
        problems.push("standIns.video.advisoryLongEdges.canonical must be a positive whole number");
      }
      const bySize = edges["bySize"];
      if (bySize !== undefined && !isObject(bySize)) {
        problems.push("standIns.video.advisoryLongEdges.bySize must be an object");
      } else if (isObject(bySize)) {
        for (const [size, edge] of Object.entries(bySize)) {
          if (!DEFAULT_STAND_IN_STANDARDS.video.standardSizes.includes(Number(size))) {
            problems.push(`standIns.video.advisoryLongEdges.bySize.${size} names no standard video size`);
          } else if (!isPositiveInteger(edge)) {
            problems.push(`standIns.video.advisoryLongEdges.bySize.${size} must be a positive whole number`);
          }
        }
      }
    }
  }
  if (problems.length > 0) return { ok: false, problems };

  const settings = value as UserSettings;
  const standards = standardsFromSettings(settings);
  const invalid = validateStandInStandards(standards);
  if (invalid.length > 0) return { ok: false, problems: invalid };
  return { ok: true, settings, standards };
}

/** Parse and check a settings file's bytes. */
export function parseUserSettings(bytes: Uint8Array): UserSettingsCheck {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, problems: ["the settings file is not valid JSON"] };
  }
  return checkUserSettings(value);
}

/** A settings file's bytes: indented JSON, so the file reads well in Drive. */
export function serializeUserSettings(settings: UserSettings): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(settings, null, 2)}\n`);
}

/** Whether a record is a settings record. */
export function isSettingsRecord(record: Pick<DataRecord, "type">): boolean {
  return record.type === SETTINGS_TYPE_ID;
}

/**
 * The winner among settings records, and the live ones it beats. The newest
 * `createdAt` wins; the id breaks an exact tie, so every node picks the same.
 */
export function pickSettingsRecord(records: readonly DataRecord[]): {
  readonly winner: DataRecord | null;
  readonly losers: readonly DataRecord[];
} {
  const live = records
    .filter((r) => !r.deletedAt && isSettingsRecord(r))
    .sort((a, b) => compareHLC(b.createdAt, a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return { winner: live[0] ?? null, losers: live.slice(1) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
