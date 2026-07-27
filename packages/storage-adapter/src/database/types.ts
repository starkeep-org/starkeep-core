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
  value: string | null;
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
  hlc: HLCTimestamp;
}

export interface FindByLabelQuery {
  /** The namespace whose label is being searched — *not* the caller's own. */
  appId: string;
  key: string;
  /**
   * Omitted = **presence** filter: any value, including the null of a bare
   * flag. Supplied = exact match. Deliberately exact-only — no ranges, no
   * prefixes, no IN-list. A value is an enum, an opaque id, a count or a
   * timestamp, and equality is the only operator that fits that contract;
   * anything richer signals an app using values as data.
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

