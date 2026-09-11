/**
 * `GET /data/records`, planned once for both servers.
 *
 * The route's parameters fall into three groups, and only the first is grammar:
 *
 *   - **Filter, projection, order and page** — `where`, `order`, `limit`,
 *     `page_token` and `aggregate`, parsed by {@link parseQuery} against the
 *     `shared.records` schema. These replaced a hand-written parameter set —
 *     `type`, `ids`, `parentId`, `cursor` and an unreachable `sort` — which was
 *     the third read grammar on the shared plane and the last one left.
 *   - **Access path** — `label`, `labelValue`, `notLabel` and `updated_after` —
 *     stays explicit. A reverse-index lookup is a join, `notLabel` is an
 *     anti-join no filter grammar expresses, and `updated_after` compares
 *     against a serialized HLC, which the parser refuses in `where` on purpose.
 *     Each one is the server's predicate rather than the caller's.
 *   - **Post-page hydration** — `include`, `labelApps`, `variant` and
 *     `variantLongEdge` — runs over the page after it is cut and filters
 *     nothing.
 *
 * ## Why this compiles to `Query` rather than running through `queryShared`
 *
 * The records page is cut by `record-queries.ts`, which is the only compiler
 * that knows the two things this route needs and no app table has: the label
 * anti-join behind `notLabel`, and the `coalesce()` over the image and video
 * metadata joins that answers `order=captured_at.desc`. The predicates
 * themselves are compiled by the same `predicateExpression` the app-syncable
 * plane uses, so one parsed `where` still means one thing on either plane.
 *
 * Aggregates take the other road: `queryShared({kind: "records"})` compiles the
 * full aggregate grammar and needs neither of those two things, so a count over
 * the library is answered there.
 */

import {
  parseVariantLongEdges,
  serializeHLC,
  type AccessGrants,
} from "@starkeep/protocol-primitives";
import {
  sharedQuerySchema,
  type AggregateQuery,
  type Filter,
  type Query,
  type RowQuery,
  type SortField,
  type WhereClause,
} from "@starkeep/storage-adapter";
import { ApiError } from "../errors.js";
import { MAX_LIMIT, parseQuery } from "./parse.js";
import { QueryParseError, type QueryParams } from "./types.js";

/** Where a parameter's value comes from, whatever transport carried it. */
export type ParamSource = (name: string) => string | undefined;

/** The reverse-index access path, as `?label=<appId>/<key>` names it. */
export interface RecordLabelPath {
  readonly appId: string;
  readonly key: string;
  /**
   * Absent is a presence filter and `""` is a bare flag, and the two are
   * different questions — see {@link FindByLabelQuery.value}.
   */
  readonly value: string | undefined;
}

/** `?variant=<appId>/<key>` and the pixel sizes to resolve against it. */
export interface RecordVariantRequest {
  readonly label: { readonly appId: string; readonly key: string };
  /** Empty asks the unnarrowed question: every candidate, with its dimensions. */
  readonly targets: readonly number[];
}

/** Everything `GET /data/records` needs, decided once. */
export interface RecordQueryPlan {
  readonly mode: "rows" | "aggregate";
  /**
   * The page, for `DatabaseAdapter.query`. Rows mode only.
   *
   * Carries the caller's parsed predicates in `where`, the server's own in
   * `filters`, and the caller's grant as a `type IN (…)` clause.
   */
  readonly query: Query;
  /** The aggregate, for `queryShared({kind: "records"})`. Aggregate mode only. */
  readonly aggregate: AggregateQuery | null;
  /** The grant predicate, which the aggregate path ANDs in itself. */
  readonly serverWhere: readonly WhereClause[];
  /**
   * True when the caller may read nothing at all.
   *
   * Answered as an empty page rather than a 403, which is what this route has
   * always done: an app with no grants asking for "the library" is asking about
   * a library that, for it, is empty. A caller naming an *ungranted type*
   * still gets a 403, because it named a resource.
   */
  readonly empty: boolean;
  /** `?label=` selects through the reverse index instead of the records table. */
  readonly labelPath: RecordLabelPath | null;
  /** What the label path pages with; the records path carries it in `query`. */
  readonly cursor: string | undefined;
  readonly includeMetadata: boolean;
  readonly includeLabels: boolean;
  readonly labelApps: string | undefined;
  readonly variant: RecordVariantRequest | null;
}

/**
 * Every parameter this route accepts.
 *
 * Listed so an unrecognized one is a 400 rather than silence. The grammar this
 * replaces read `type`, `parentId` and the rest as named parameters, so a
 * misspelled `parent_id` used to mean nothing and would now mean nothing again
 * — except that answering the whole library to a caller that asked for one
 * record's children is the kind of wrong answer nobody notices.
 */
const RECORD_PARAMS: readonly string[] = [
  // Grammar.
  "where",
  "order",
  "limit",
  "page_token",
  "include",
  "aggregate",
  "select",
  // Access paths.
  "label",
  "labelValue",
  "notLabel",
  "updated_after",
  // Hydration.
  "labelApps",
  "variant",
  "variantLongEdge",
];

/**
 * Column names as `Query.sort` spells them.
 *
 * `record-queries.ts` speaks the `DataRecord` field names and the grammar
 * speaks column names, so the two lists are translated rather than reconciled:
 * a column name is what an app writes and a field name is what the platform's
 * own callers write, and neither should have to learn the other.
 */
const SORT_FIELD_OF: Record<string, string> = {
  id: "id",
  type: "type",
  created_at: "createdAt",
  updated_at: "updatedAt",
  version: "version",
  content_hash: "contentHash",
  object_storage_key: "objectStorageKey",
  mime_type: "mimeType",
  size_bytes: "sizeBytes",
  original_filename: "originalFilename",
  origin_app_id: "originAppId",
  parent_id: "parentId",
  node_id: "node_id",
  captured_at: "capturedAt",
};

/** Read a `<appId>/<key>` label reference, or reject it by name. */
function labelRef(parameter: string, raw: string): { appId: string; key: string } {
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) {
    throw new ApiError(
      `${parameter} must be of the form "<appId>/<key>" (got "${raw}")`,
      400,
    );
  }
  return { appId: raw.slice(0, slash), key: raw.slice(slash + 1) };
}

/**
 * Plan one request.
 *
 * `defaultLimit` is the route's own, not the grammar's: the local server has
 * always answered 100 records and the cloud handler 50, and a caller that has
 * never sent `limit` should not find its page size changed by a refactor. The
 * grammar's own default of 30 applies to the routes that were born with it.
 */
export function planRecordQuery(
  grants: AccessGrants,
  get: ParamSource,
  options: { readonly defaultLimit: number },
): RecordQueryPlan {
  const schema = sharedQuerySchema({ kind: "records" });

  const pageTokenParam = get("page_token");
  const whereParam = get("where");
  const aggregateParam = get("aggregate");

  // `select` is the `GROUP BY` list of an aggregate and a column projection
  // everywhere else, and this route has no projection to narrow: it answers a
  // rendered record — a category, an availability, a set of variants and a
  // hydrated metadata row — rather than the columns of `shared.records`. A
  // caller wanting columns has `/data/metadata/:category`.
  const selectParam = get("select");
  if (selectParam !== undefined && aggregateParam === undefined) {
    throw new QueryParseError(
      `select projects columns, and /data/records answers a rendered record rather ` +
        `than a row; it applies to aggregate as the grouping list only`,
    );
  }

  const params: QueryParams = {
    where: whereParam,
    order: get("order"),
    include: get("include"),
    limit: String(boundedLimit(get("limit"), options.defaultLimit)),
    ...(aggregateParam === undefined ? {} : { aggregate: aggregateParam }),
    ...(selectParam === undefined ? {} : { select: selectParam }),
  };

  const parsed = parseQuery(schema, params);

  // The grant, as a predicate on the discriminant rather than a filter over
  // what a scan returned. Omitted under `allAccess`, whose authorization is by
  // app id and cannot be written as a finite set of types.
  const readableTypes = [...grants.readableTypes].sort();
  if (!grants.allAccess) assertNamedTypesReadable(parsed.where, grants);
  const empty = !grants.allAccess && readableTypes.length === 0;
  const serverWhere: WhereClause[] = grants.allAccess
    ? []
    : [{ column: "type", predicate: { op: "in", values: readableTypes } }];

  const include = parsed.mode === "rows" ? parsed.include : [];
  const labelParam = get("label");
  const labelValue = get("labelValue");
  if (labelValue !== undefined && labelParam === undefined) {
    throw new ApiError("labelValue requires label", 400);
  }
  const notLabelParam = get("notLabel");

  if (parsed.mode === "aggregate") {
    // The two access paths the aggregate compiler does not build: a reverse
    // index is a different table and `notLabel` is a `NOT EXISTS`. Rejected
    // rather than ignored, because a count that quietly counted the wrong rows
    // is the one answer a caller cannot check.
    for (const [name, value] of [
      ["label", labelParam],
      ["notLabel", notLabelParam],
      ["variant", get("variant")],
    ] as const) {
      if (value !== undefined) {
        throw new QueryParseError(`"${name}" selects or hydrates rows, and an aggregate holds none`);
      }
    }
    return {
      mode: "aggregate",
      query: {},
      aggregate: withUpdatedAfter(parsed, get("updated_after")),
      serverWhere,
      empty,
      labelPath: null,
      cursor: undefined,
      includeMetadata: false,
      includeLabels: false,
      labelApps: undefined,
      variant: null,
    };
  }

  const rows = parsed as RowQuery;
  const filters: Filter[] = [{ field: "deletedAt", operator: "isNull" }];
  const updatedAfter = hlcLowerBound(get("updated_after"));
  if (updatedAfter) filters.push(updatedAfter);

  const query: Query = {
    filters,
    where: [...rows.where, ...serverWhere],
    ...(rows.order.length > 0 ? { sort: sortFor(rows) } : {}),
    limit: rows.limit,
    ...(pageTokenParam === undefined ? {} : { cursor: pageTokenParam }),
    ...(notLabelParam === undefined
      ? {}
      : { excludeLabel: labelRef("notLabel", notLabelParam) }),
  };

  return {
    mode: "rows",
    query,
    aggregate: null,
    serverWhere,
    empty,
    labelPath:
      labelParam === undefined
        ? null
        : { ...labelRef("label", labelParam), value: labelValue },
    cursor: pageTokenParam,
    includeMetadata: include.includes("metadata"),
    includeLabels: include.includes("labels"),
    labelApps: get("labelApps"),
    variant: variantRequest(get("variant"), get("variantLongEdge")),
  };
}

/** Reject a parameter this route does not accept. */
export function assertRecordParams(names: Iterable<string>): void {
  for (const name of names) {
    if (!RECORD_PARAMS.includes(name)) {
      throw new QueryParseError(
        `"${name}" is not a parameter of /data/records. Filters go under where as ` +
          `JSON, e.g. where={"${name}":"…"}. Parameters: ${RECORD_PARAMS.join(", ")}`,
      );
    }
  }
}

/**
 * A caller that named a type it may not read gets a 403, not an empty page.
 *
 * The grant is ANDed into the query either way, so an ungranted type returns
 * nothing whether or not this check exists. What it adds is the difference
 * between "there are no photographs of this kind" and "not yours" — the same
 * distinction the route has drawn since `?type=` was a parameter, restated over
 * the parsed clause so the grammar inherits it rather than losing it.
 *
 * Only an `eq` or an `in` names a finite set. A range or a pattern over `type`
 * describes a set the caller may not know the membership of, so the grant
 * predicate narrowing it silently is the right answer there.
 */
function assertNamedTypesReadable(
  where: readonly WhereClause[],
  grants: AccessGrants,
): void {
  for (const clause of where) {
    if (clause.column !== "type") continue;
    const named =
      clause.predicate.op === "eq"
        ? [clause.predicate.value]
        : clause.predicate.op === "in"
          ? [...clause.predicate.values]
          : null;
    if (named === null) continue;
    if (!named.some((type) => typeof type === "string" && grants.readableTypes.has(type))) {
      throw new ApiError(
        `No read grant on ${named.map((t) => JSON.stringify(t)).join(", ")}`,
        403,
      );
    }
  }
}

/**
 * The page size, clamped rather than rejected.
 *
 * The grammar rejects a `limit` above its ceiling, because a caller writing one
 * has misunderstood the contract and a silently smaller page is how that
 * misunderstanding survives. This route clamps instead: `?limit=1000` has meant
 * "give me everything" on both servers since before the ceiling existed, and
 * the page it gets back carries `hasMore` and a cursor, so nothing is lost —
 * the caller pages once more.
 */
function boundedLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new QueryParseError(`limit must be a whole number of at least 1`);
  }
  return Math.min(parsed, MAX_LIMIT);
}

/**
 * The ordering, as `record-queries.ts` names it.
 *
 * The parser's null position is not passed through, because that compiler
 * emits every key as `(expr IS NULL, expr)` and therefore sorts nulls last in
 * both dialects whatever the key's direction — the one convention that makes a
 * cursor mean the same thing against a local and a cloud data-server. A caller
 * asking for `nullsfirst` is asking for an ordering this route cannot produce,
 * so it is refused rather than quietly answered with the other one.
 *
 * The primary-key tiebreaker the parser appends is passed through as well;
 * `orderingFor` recognizes a trailing `id` and adopts its direction rather than
 * appending a second one.
 */
function sortFor(rows: RowQuery): SortField[] {
  return rows.order.map((term) => {
    if (term.nulls !== "last") {
      throw new QueryParseError(
        `/data/records sorts nulls last on every key, because the cursor it cuts ` +
          `has to mean the same thing on both engines; "${term.column}.nullsfirst" ` +
          `is not available here`,
      );
    }
    const field = SORT_FIELD_OF[term.column];
    if (field === undefined) {
      throw new QueryParseError(`"${term.column}" is not an ordering key of /data/records`);
    }
    return { field, direction: term.direction };
  });
}

/**
 * `updated_after=<iso>` as a lower bound on the serialized HLC.
 *
 * The server owns this one. `updated_at` is a sync-internal clock and the
 * parser refuses it in `where` on purpose, so converting an instant a caller
 * can express into a bound only the platform can construct is the server's job
 * rather than a hole in the grammar.
 *
 * An unparseable date is ignored rather than rejected, which is what both
 * servers have always done.
 */
function hlcLowerBound(raw: string | undefined): Filter | null {
  if (raw === undefined || raw === "") return null;
  const ms = new Date(raw).getTime();
  if (Number.isNaN(ms)) return null;
  return {
    field: "updatedAt",
    operator: "gt",
    value: serializeHLC({ wallTime: ms, counter: 0, nodeId: "" }),
  };
}

/**
 * The same bound, for the aggregate path.
 *
 * `queryShared` takes the whole predicate in the parsed value, and the records
 * schema declares `updated_at` as `text` — which is what a serialized HLC is —
 * so the bound rides in as an ordinary clause there.
 */
function withUpdatedAfter(query: AggregateQuery, raw: string | undefined): AggregateQuery {
  const bound = hlcLowerBound(raw);
  if (!bound) return query;
  return {
    ...query,
    where: [
      ...query.where,
      { column: "updated_at", predicate: { op: "gt", value: bound.value as string } },
    ],
  };
}

function variantRequest(
  variant: string | undefined,
  longEdge: string | undefined,
): RecordVariantRequest | null {
  if (variant === undefined) {
    if (longEdge === undefined) return null;
    // A pixel size with nothing to resolve it against is meaningless, and
    // answering it as though it were valid returns no variants — which reads as
    // "this record has none" rather than "you asked wrongly".
    throw new ApiError("variantLongEdge requires variant", 400);
  }
  const label = labelRef("variant", variant);
  if (longEdge === undefined) return { label, targets: [] };
  const parsed = parseVariantLongEdges(longEdge);
  if (!parsed.ok) throw new ApiError(parsed.message, 400);
  return { label, targets: parsed.targets };
}
