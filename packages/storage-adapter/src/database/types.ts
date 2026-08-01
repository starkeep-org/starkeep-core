import type {
  DataRecord,
  HLCTimestamp,
  RecordLabel,
  StarkeepId,
} from "@starkeep/protocol-primitives";

export type SortDirection = "asc" | "desc";

export type FilterOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "like"
  | "isNull"
  | "isNotNull";

export interface Filter {
  field: string;
  operator: FilterOperator;
  /** Ignored for `isNull` and `isNotNull`. */
  value?: unknown;
}

export interface SortField {
  field: string;
  direction: SortDirection;
}

export interface Query {
  type?: string;
  filters?: Filter[];
  sort?: SortField[];
  limit?: number;
  cursor?: string;
  /**
   * Exclude records carrying a live label with this `(appId, key)`, at any
   * value. A **negated** filter, which is why it can't be expressed as a
   * {@link Filter}: those constrain columns on the records row, and this is an
   * anti-join against the labels table.
   *
   * It exists so a grid can page originals server-side. With a rendition label
   * on every derived child, "everything except renditions" is one indexed
   * query; without it a 60k-item library is 300k+ rows and paging is
   * meaningless — a page of 100 might contain no originals at all, so the
   * client cannot even tell how far to keep reading.
   *
   * Deliberately no value component. `?label=` distinguishes presence from a
   * specific value because a positive query has a reason to; a negated one
   * asking "not carrying key K with value V" would silently *include* records
   * carrying K with some other value, which reads as the opposite of what it
   * says.
   */
  excludeLabel?: { appId: string; key: string };
}

export interface QueryResult {
  records: DataRecord[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** One row to write via {@link DatabaseAdapter.upsertLabels}. */
export interface LabelUpsert {
  recordId: StarkeepId;
  /** Server-set from the authenticated subject; never client-supplied. */
  appId: string;
  key: string;
  /** In the primary key. `""` is a bare flag; never null. */
  value: string;
  /** Denormalized from `records.type`; the caller reads it as part of the
   *  same batch that checks the record exists. */
  recordType: string;
  hlc: HLCTimestamp;
}

/** One row to tombstone via {@link DatabaseAdapter.retractLabels}. */
export interface LabelRetraction {
  recordId: StarkeepId;
  appId: string;
  key: string;
  /**
   * Which value to tombstone. **Omitted tombstones every value of this key on
   * this record** — the reading that keeps a `{record, key}` retraction meaning
   * "take this assertion back" now that a key is set-valued.
   */
  value?: string;
  hlc: HLCTimestamp;
}

/**
 * Replace the entire value set for one `(record, app, key)` — see
 * {@link DatabaseAdapter.replaceLabelValues}.
 */
export interface LabelValueReplacement {
  recordId: StarkeepId;
  appId: string;
  key: string;
  /** The complete desired set. Empty retracts every value of the key. */
  values: string[];
  /** Denormalized from `records.type`, as for {@link LabelUpsert}. */
  recordType: string;
  hlc: HLCTimestamp;
}

export interface FindByLabelQuery {
  /** The namespace whose label is being searched — *not* the caller's own. */
  appId: string;
  key: string;
  /**
   * Omitted = **presence** filter: any value, bare flags included. Supplied =
   * exact match, and `""` specifically matches bare flags. Deliberately
   * exact-only — no ranges, no prefixes, no IN-list. A value is an enum, an
   * opaque id, a count or a timestamp, and equality is the only operator that
   * fits that contract; anything richer signals an app using values as data.
   *
   * Callers parsing this off a query string must distinguish an **absent**
   * parameter from an **empty** one (`.has()` vs `.get()`): `?labelValue=` is a
   * request for bare flags, and reading it as "no filter" silently returns a
   * superset — which looks like it works.
   */
  value?: string;
  /**
   * The caller's readable types. Applied as an index condition (`record_type`
   * rides in the reverse index), so unreadable rows are never materialized and
   * a page comes back full. `undefined` means all-access (Drive).
   */
  readableTypes?: ReadonlySet<string>;
  limit?: number;
  /**
   * Opaque continuation token. Encodes the composite `(value, record_id)` —
   * the reverse index's own residual order — **not** a bare record id. A bare
   * id is only correct when `value` is pinned or uniformly null; on a
   * value-less query against a key with varied values it would silently skip
   * and repeat rows. Callers never inspect it; implementations must not
   * "simplify" it back to an id.
   */
  cursor?: string;
}

export interface FindByLabelResult {
  /** Matching label rows, in `(value, record_id)` order. */
  labels: RecordLabel[];
  nextCursor: string | null;
  hasMore: boolean;
}

export type BatchOperation =
  | { type: "put"; record: DataRecord }
  | { type: "delete"; id: StarkeepId; hlc: HLCTimestamp };

export interface Transaction {
  put(record: DataRecord): Promise<void>;
  get(id: StarkeepId): Promise<DataRecord | null>;
  delete(id: StarkeepId, hlc: HLCTimestamp): Promise<void>;
  query(query: Query): Promise<QueryResult>;
}

