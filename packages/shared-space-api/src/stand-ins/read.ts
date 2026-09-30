/**
 * Reading stand-ins: the size summary as the wire renders it, and the content
 * read at a chosen size. Shared by both data servers, which differ only in
 * where bytes sit and how a URL is minted.
 */

import {
  canRead,
  isStandInOriginal,
  resolveSize,
  type AccessGrants,
  type DataRecord,
  type SizePlacement,
  type StandInSize,
  type StandInStandards,
  type StandInSummary,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import { loadStandInSummariesForPage, type DatabaseAdapter } from "@starkeep/storage-adapter";

/** One size of an original, as `stand_ins.sizes[]` carries it. */
export interface WireStandInSize {
  readonly fidelity: number;
  readonly role: StandInSize["role"];
  readonly record_id: string | null;
  readonly type: string | null;
  readonly size_bytes: number | null;
  readonly placement: SizePlacement;
  readonly url?: string;
}

export interface WireStandInSummary {
  readonly category: string;
  readonly fidelity: number | null;
  readonly status: StandInSummary["status"];
  readonly top: number | null;
  /** The fidelity a canonical stand-in should report now; see `StandInSummary`. */
  readonly canonical_target: number | null;
  /** True when the live canonical stand-in was made for another threshold. */
  readonly canonical_outdated: boolean;
  readonly sizes: readonly WireStandInSize[];
  /** Where the original's own bytes sit on the node that answered. */
  readonly original_placement: SizePlacement;
}

/**
 * Render a summary. `urlFor`, when given, is asked for each size that has a
 * record, and may answer undefined for bytes the caller cannot read now.
 */
export async function renderStandInSummary(
  summary: StandInSummary,
  urlFor?: (size: StandInSize) => Promise<string | undefined>,
): Promise<WireStandInSummary> {
  return {
    category: summary.category,
    fidelity: summary.fidelity,
    status: summary.status,
    top: summary.top,
    canonical_target: summary.canonicalTarget,
    canonical_outdated: summary.canonicalOutdated,
    sizes: await Promise.all(
      summary.sizes.map(async (size) => {
        const url = urlFor && size.recordId ? await urlFor(size) : undefined;
        return {
          fidelity: size.fidelity,
          role: size.role,
          record_id: size.recordId,
          type: size.type,
          size_bytes: size.sizeBytes,
          placement: size.placement,
          ...(url ? { url } : {}),
        };
      }),
    ),
    original_placement: summary.originalPlacement,
  };
}

/** `?size=` as a request: a positive integer, or `canonical`. */
export function parseSizeParam(raw: string | null | undefined): number | "canonical" | null {
  if (raw === "canonical") return "canonical";
  if (raw === null || raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

export type ContentReadOutcome =
  | {
      readonly ok: true;
      readonly original: DataRecord;
      readonly summary: StandInSummary;
      /** The size that answers, with its record id, type and key. */
      readonly size: StandInSize;
    }
  | { readonly ok: false; readonly status: number; readonly body: Record<string, unknown> };

/**
 * Resolve `GET /data/records/:id/content-url?size=` to the record that answers.
 *
 * The id names the original, because the original is the item a listing
 * shows; asking a stand-in for its own sizes is refused rather than answered
 * about its parent, since a caller holding a stand-in id already has the file
 * it names.
 */
export async function resolveContentRead(
  db: DatabaseAdapter,
  grants: AccessGrants,
  recordId: string,
  sizeParam: string | null | undefined,
  standards: StandInStandards,
  placementOf: (record: DataRecord) => Promise<SizePlacement>,
): Promise<ContentReadOutcome> {
  const requested = parseSizeParam(sizeParam);
  if (requested === null) {
    return fail(400, "InvalidSize", "size must be a positive whole number or canonical");
  }
  const original = await db.get(recordId as StarkeepId);
  if (!original || original.deletedAt || !canRead(grants, original.type)) {
    return fail(404, "NotFound", "Record not found");
  }
  if (!isStandInOriginal(original)) {
    return fail(
      400,
      "NotAnOriginal",
      original.standInRole
        ? "this record is a stand-in; ask its original, named in parent_id"
        : "only an original in a stand-in category has sizes",
    );
  }
  const summaries = await loadStandInSummariesForPage(db, [original], standards, placementOf);
  const summary = summaries.get(original.id)!;
  const resolution = resolveSize(summary, requested, standards);
  switch (resolution.kind) {
    case "serve":
      return { ok: true, original, summary, size: resolution.size };
    case "not-standard":
      return fail(400, "NotAStandardSize", resolution.message);
    case "unknown-fidelity":
      return fail(404, "FidelityUnknown", "nobody has reported this original's fidelity, so it has no sizes yet", {
        stand_ins: await renderStandInSummary(summary),
      });
    case "not-produced":
      return fail(404, "SizeNotProduced", `no stand-in exists at ${resolution.fidelity} yet`, {
        fidelity: resolution.fidelity,
        stand_ins: await renderStandInSummary(summary),
      });
  }
}

function fail(
  status: number,
  error: string,
  detail: string,
  extra: Record<string, unknown> = {},
): { readonly ok: false; readonly status: number; readonly body: Record<string, unknown> } {
  return { ok: false, status, body: { error, detail, ...extra } };
}
