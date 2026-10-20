/**
 * The deployment's settings: what the operator chose for every node and the
 * cloud. One document per deployment, held outside every user's library.
 *
 * ## Where the document lives
 *
 * - **With a cloud.** An SSM parameter, `/<prefix>/platform/deployment-settings`.
 *   Admin-web writes it through Manager. The cloud data server reads it and
 *   serves it at {@link DEPLOYMENT_SETTINGS_ROUTE} on the Drive channel, so
 *   every node reads one value and no user's data holds it.
 * - **Without a cloud.** The local data server's `~/.starkeep/config.json`,
 *   under `deploymentSettings`. Cloud setup seeds the parameter from these
 *   values once.
 *
 * ## The rules
 *
 * - **Absence.** No document means the platform defaults. Defaults never count
 *   as a write, so a new node cannot overwrite the operator's choice.
 * - **Every field is optional.** An absent field takes the platform's default,
 *   so a document written by an older build keeps its meaning when a newer
 *   build adds a setting.
 * - **Unknown fields are ignored**, so a newer build's document still reads.
 *
 * Node-local settings, such as sync-down ceilings, are not here: they affect
 * one machine and stay in that machine's config.
 *
 * See `~/projects/starkeep/plan-multi-user-roles-2026-10-16.md`, phase 1.
 */

import {
  DEFAULT_STAND_IN_STANDARDS,
  validateStandInStandards,
  type CategoryStandards,
  type StandInStandards,
} from "../stand-ins/standards.js";

/**
 * How long a deleted item stays recoverable when the settings say nothing.
 *
 * Long enough that a person who notices a mistake a fortnight later still has the
 * item, and short enough that the tombstone set stays a bounded log rather than a
 * second copy of the library.
 */
export const DEFAULT_TRASH_RETENTION_DAYS = 30;

/**
 * The Drive-channel route that serves the document, relative to
 * `/apps/starkeep-drive`. Answers `{ settings: DeploymentSettings | null }`,
 * where null means no document is set.
 */
export const DEPLOYMENT_SETTINGS_ROUTE = "/deployment/settings";

/** The document. Every field is optional; see the rules above. */
export interface DeploymentSettings {
  /**
   * How long a deleted item stays recoverable, and how long its bytes stay.
   *
   * One window for both, deliberately. A Trash view that promised a restore date
   * while the reaper worked to another number would be promising something the
   * platform does not hold to, and a restore inside this window is pure row work
   * precisely because the reaper has not touched the bytes yet.
   *
   * It is also the guarantee an app reads: an app that reconciles at least once
   * per window gets a complete answer from `deleted=only&updated_after=<hlc>`,
   * and an app that falls further behind must do a full reconcile against the
   * live set. That is why the value is a setting an app can read rather than a
   * constant compiled into one.
   */
  readonly trash?: { readonly retentionDays?: number };
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

/** How long a deleted item stays recoverable under these settings. */
export function retentionDaysFromSettings(
  settings: DeploymentSettings,
  fallback: number = DEFAULT_TRASH_RETENTION_DAYS,
): number {
  return settings.trash?.retentionDays ?? fallback;
}

/** The stand-in standards these settings amount to. */
export function standardsFromSettings(
  settings: DeploymentSettings,
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
 * the document can hold, so it states what the operator saw when they saved.
 */
export function settingsFromStandards(standards: StandInStandards): DeploymentSettings {
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

export type DeploymentSettingsCheck =
  | {
      readonly ok: true;
      readonly settings: DeploymentSettings;
      readonly standards: StandInStandards;
    }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Check a parsed settings value: its shape, and the standards it amounts to.
 * Unknown fields are ignored, so a newer build's document still reads here.
 */
export function checkDeploymentSettings(value: unknown): DeploymentSettingsCheck {
  const problems: string[] = [];
  if (!isObject(value)) return { ok: false, problems: ["the settings must be a JSON object"] };
  const trash = value["trash"];
  if (trash !== undefined && !isObject(trash)) {
    problems.push("trash must be an object");
  } else if (isObject(trash)) {
    const days = trash["retentionDays"];
    if (days !== undefined && !isPositiveInteger(days)) {
      problems.push("trash.retentionDays must be a positive whole number of days");
    }
  }
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
            problems.push(
              `standIns.video.advisoryLongEdges.bySize.${size} names no standard video size`,
            );
          } else if (!isPositiveInteger(edge)) {
            problems.push(
              `standIns.video.advisoryLongEdges.bySize.${size} must be a positive whole number`,
            );
          }
        }
      }
    }
  }
  if (problems.length > 0) return { ok: false, problems };

  const settings = value as DeploymentSettings;
  const standards = standardsFromSettings(settings);
  const invalid = validateStandInStandards(standards);
  if (invalid.length > 0) return { ok: false, problems: invalid };
  return { ok: true, settings, standards };
}

/** Parse and check a document's JSON text. */
export function parseDeploymentSettings(text: string): DeploymentSettingsCheck {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problems: ["the settings are not valid JSON"] };
  }
  return checkDeploymentSettings(value);
}

/** A document's JSON text, compact, as SSM stores it. */
export function serializeDeploymentSettings(settings: DeploymentSettings): string {
  return JSON.stringify(settings);
}

/**
 * The document after one change. A field the change leaves out keeps its
 * current value, so a writer of one setting never erases another. The
 * standards are written out whole, as {@link settingsFromStandards} does.
 */
export function withDeploymentSettingsChange(
  current: DeploymentSettings,
  change: DeploymentSettings,
): DeploymentSettings {
  const retentionDays = change.trash?.retentionDays ?? current.trash?.retentionDays;
  const standIns =
    change.standIns === undefined
      ? current.standIns
      : settingsFromStandards(standardsFromSettings(change, standardsFromSettings(current)))
          .standIns;
  return {
    ...(retentionDays !== undefined ? { trash: { retentionDays } } : {}),
    ...(standIns !== undefined ? { standIns } : {}),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
