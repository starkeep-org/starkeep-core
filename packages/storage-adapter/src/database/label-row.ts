/**
 * The stored shape of a label row, and its conversion to and from
 * {@link RecordLabel}.
 *
 * Both backends store labels in the same nine all-text columns — SQLite in
 * `shared_record_labels`, DSQL in `shared.record_labels` — so this lives once
 * here rather than once per adapter. The two copies it replaces were
 * character-identical, which is the failure mode worth avoiding: a change to
 * the HLC encoding or a new column applied to one and not the other would
 * diverge silently, and nothing in either package's tests would notice.
 */

import type { RecordLabel } from "@starkeep/protocol-primitives";
import { serializeHLC, deserializeHLC, createStarkeepId } from "@starkeep/protocol-primitives";

export interface LabelRow {
  record_id: string;
  app_id: string;
  key: string;
  /** NOT NULL and part of the primary key; `""` is a bare flag. */
  value: string;
  record_type: string;
  created_at: string;
  updated_at: string;
  node_id: string;
  deleted_at: string | null;
}

export function rowToLabel(row: LabelRow): RecordLabel {
  return {
    recordId: createStarkeepId(row.record_id),
    appId: row.app_id,
    key: row.key,
    value: row.value,
    recordType: row.record_type,
    createdAt: deserializeHLC(row.created_at),
    updatedAt: deserializeHLC(row.updated_at),
    nodeId: row.node_id,
    deletedAt: row.deleted_at ? deserializeHLC(row.deleted_at) : null,
  };
}

export function labelToRow(label: RecordLabel): LabelRow {
  return {
    record_id: label.recordId,
    app_id: label.appId,
    key: label.key,
    value: label.value,
    record_type: label.recordType,
    created_at: serializeHLC(label.createdAt),
    updated_at: serializeHLC(label.updatedAt),
    // Denormalized from the LWW timestamp, per the existing convention — the
    // row's own `nodeId` field is not consulted, so a snapshot that disagreed
    // with its own updatedAt cannot write an inconsistent row.
    node_id: label.updatedAt.nodeId,
    deleted_at: label.deletedAt ? serializeHLC(label.deletedAt) : null,
  };
}
