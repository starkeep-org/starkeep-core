/**
 * What work the phone does, in what order, under what conditions (item 14).
 *
 * ## The constraints this encodes
 *
 * From the media plan, and applied to Android deliberately even though Android
 * would permit more, so that iOS is a port rather than a rewrite:
 *
 * 1. No sync round may be assumed to complete.
 * 2. No work item may assume more than a few seconds.
 * 3. Byte transfer is delegated to an OS-managed mechanism surviving app death.
 * 4. Nothing is scheduled that depends on the app being open.
 *
 * **There is no foreground service.** A phone asked to carry a 60k-item library
 * does it across many short windows over days, not in one run. Anything that
 * quietly assumes otherwise is a bug even when it works on a dev handset
 * plugged into a laptop — which is the environment where such an assumption is
 * least likely to be noticed.
 *
 * ## Why the graph is data rather than code
 *
 * WorkManager wants declarations: what to run, what it needs, what it depends
 * on. Expressing that as a table makes the *policy* testable without a device —
 * ordering, constraints, backoff and the "is this safe to abandon" property are
 * all decidable here, and only the binding needs hardware.
 */

/** Conditions the OS must satisfy before a job may run. */
export interface JobConstraints {
  /**
   * Requires an unmetered connection.
   *
   * True for anything moving originals. A phone that uploads a 4 GB video over
   * cellular has not done the user a favour, however correct the transfer was,
   * and metered-connection billing is the kind of harm no retry logic undoes.
   */
  readonly requiresUnmetered: boolean;
  readonly requiresNetwork: boolean;
  /**
   * Requires the device to be charging.
   *
   * Reserved for derivation, which is the only genuinely CPU-hungry work here.
   * Requiring it for sync would mean a phone that is never plugged in never
   * syncs, which is worse than a slightly emptier battery.
   */
  readonly requiresCharging: boolean;
  /** Requires storage not to be low — eviction is exempt, since it frees space. */
  readonly requiresStorageNotLow: boolean;
}

export type JobId =
  /** One metadata exchange round. Small, frequent, cheap. */
  | "sync-metadata"
  /** Fetch blobs residency says this node wants. */
  | "fetch-blobs"
  /** Push local blobs the cloud does not have. */
  | "push-blobs"
  /** Derive the ladder for locally captured media. */
  | "derive-ladder"
  /** Drop blobs the budget no longer allows. */
  | "evict"
  /** Observe MediaStore for new captures. */
  | "scan-media-store";

export interface JobSpec {
  readonly id: JobId;
  /** Human-readable, for the debug screen. */
  readonly description: string;
  readonly constraints: JobConstraints;
  /**
   * Roughly how long one unit of this job should take.
   *
   * Not a timeout — a budget for sizing the unit. Anything whose natural unit
   * exceeds a few seconds has to be split, because the OS decides when the app
   * stops and a unit that cannot finish in its window never finishes at all.
   */
  readonly targetSecondsPerUnit: number;
  /**
   * Whether abandoning this job midway is safe.
   *
   * Every job here must be, and the type exists to make an exception visible
   * rather than to permit one — a job that is unsafe to abandon cannot be
   * scheduled under constraint 1 at all, so this is an assertion the tests
   * check rather than a knob.
   */
  readonly resumable: true;
  /** Jobs that should have run first. Advisory ordering, not a hard barrier. */
  readonly after: readonly JobId[];
  /**
   * Whether the OS should carry the bytes rather than the app.
   *
   * Constraint 3. A transfer the app performs itself dies when the app does,
   * which on a phone is constantly — so large transfers are handed to a
   * download/upload manager that survives it.
   */
  readonly delegatedTransfer: boolean;
}

const NO_NETWORK: JobConstraints = {
  requiresUnmetered: false,
  requiresNetwork: false,
  requiresCharging: false,
  requiresStorageNotLow: true,
};

export const JOB_GRAPH: readonly JobSpec[] = [
  {
    id: "scan-media-store",
    description: "Notice photos and videos the camera has taken",
    // No network at all: this reads a local content provider. Requiring
    // connectivity would mean a phone in airplane mode forgets what it shot.
    constraints: NO_NETWORK,
    targetSecondsPerUnit: 2,
    resumable: true,
    after: [],
    delegatedTransfer: false,
  },
  {
    id: "sync-metadata",
    description: "Exchange records and labels with the cloud",
    constraints: {
      requiresUnmetered: false,
      requiresNetwork: true,
      requiresCharging: false,
      requiresStorageNotLow: true,
    },
    // Metadata is small, so this runs on cellular deliberately: the library
    // staying browsable is worth a few kilobytes, and it is what makes elided
    // records visible at all.
    targetSecondsPerUnit: 5,
    resumable: true,
    after: [],
    delegatedTransfer: false,
  },
  {
    id: "derive-ladder",
    description: "Derive renditions for locally captured media",
    constraints: {
      requiresUnmetered: false,
      requiresNetwork: false,
      requiresCharging: true,
      requiresStorageNotLow: true,
    },
    targetSecondsPerUnit: 10,
    resumable: true,
    // Derivation reads what the scan found. Ordering is advisory rather than a
    // barrier: a scan that has not run yet simply means there is nothing to
    // derive, which is not a reason to block.
    after: ["scan-media-store"],
    delegatedTransfer: false,
  },
  {
    id: "push-blobs",
    description: "Upload local originals and renditions the cloud lacks",
    constraints: {
      requiresUnmetered: true,
      requiresNetwork: true,
      requiresCharging: false,
      requiresStorageNotLow: true,
    },
    targetSecondsPerUnit: 5,
    resumable: true,
    // Renditions before originals is the rule, and derivation is what produces
    // them — pushing first would send a 40 MB original where a 130 KB
    // rendition would have done.
    after: ["derive-ladder", "sync-metadata"],
    delegatedTransfer: true,
  },
  {
    id: "fetch-blobs",
    description: "Download the bytes residency says this node wants",
    constraints: {
      requiresUnmetered: true,
      requiresNetwork: true,
      requiresCharging: false,
      requiresStorageNotLow: true,
    },
    targetSecondsPerUnit: 5,
    resumable: true,
    // Fetching before the metadata round would be fetching against a stale idea
    // of what exists.
    after: ["sync-metadata"],
    delegatedTransfer: true,
  },
  {
    id: "evict",
    description: "Drop blobs the budget no longer allows",
    constraints: {
      requiresUnmetered: false,
      requiresNetwork: false,
      requiresCharging: false,
      // The one job exempt from the storage floor, because it is what fixes it.
      // Gating eviction on free space is a deadlock: the phone fills up and
      // then cannot run the job that would empty it.
      requiresStorageNotLow: false,
    },
    targetSecondsPerUnit: 2,
    resumable: true,
    // Eviction must know what is durable elsewhere before dropping anything,
    // and that is what the metadata round establishes.
    after: ["sync-metadata"],
    delegatedTransfer: false,
  },
];

export function jobSpec(id: JobId): JobSpec {
  const found = JOB_GRAPH.find((j) => j.id === id);
  if (!found) throw new Error(`unknown job: ${id}`);
  return found;
}

/**
 * A run order that respects every `after`.
 *
 * Advisory: the result is the order to *prefer*, not a set of barriers. A job
 * whose predecessor has not run is still allowed to run — it will simply find
 * nothing to do — because a hard barrier means one stalled job stops the phone
 * making any progress at all, which under constraint 1 is the likeliest state.
 */
export function preferredOrder(): JobId[] {
  const ordered: JobId[] = [];
  const visiting = new Set<JobId>();

  const visit = (id: JobId): void => {
    if (ordered.includes(id)) return;
    // A cycle in a hand-written table is a mistake rather than a possibility to
    // support, but it must not hang the scheduler.
    if (visiting.has(id)) return;
    visiting.add(id);
    for (const dep of jobSpec(id).after) visit(dep);
    visiting.delete(id);
    ordered.push(id);
  };

  for (const job of JOB_GRAPH) visit(job.id);
  return ordered;
}

/**
 * Exponential backoff for a job that keeps failing.
 *
 * Capped, and the cap matters more than the curve: an uncapped backoff on a
 * phone that was offline for a week returns from that week with a retry delay
 * measured in days, so the first thing it does on regaining connectivity is
 * nothing.
 */
export const MIN_BACKOFF_MS = 30_000;
export const MAX_BACKOFF_MS = 60 * 60_000;

export function backoffMs(attempt: number): number {
  if (attempt <= 0) return 0;
  return Math.min(MIN_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

/** Device conditions, as the scheduler sees them. */
export interface DeviceState {
  readonly hasNetwork: boolean;
  readonly isUnmetered: boolean;
  readonly isCharging: boolean;
  readonly isStorageLow: boolean;
}

/** Whether the OS conditions currently permit this job. */
export function canRun(spec: JobSpec, device: DeviceState): boolean {
  if (spec.constraints.requiresNetwork && !device.hasNetwork) return false;
  if (spec.constraints.requiresUnmetered && !device.isUnmetered) return false;
  if (spec.constraints.requiresCharging && !device.isCharging) return false;
  if (spec.constraints.requiresStorageNotLow && device.isStorageLow) return false;
  return true;
}

/** Everything runnable right now, in preferred order. */
export function runnableJobs(device: DeviceState): JobId[] {
  return preferredOrder().filter((id) => canRun(jobSpec(id), device));
}
