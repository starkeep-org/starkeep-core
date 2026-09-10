/**
 * The parsed-query vocabulary, re-exported.
 *
 * The types themselves live in `@starkeep/storage-adapter`, because the two SQL
 * compilers that consume them sit there and this package sits above it. The
 * parser is here; the shapes it produces are one layer down, where everything
 * that has to agree about them can see them.
 */
export {
  QueryParseError,
  LIKE_ESCAPE_CHAR,
  type AppColumnInfo,
  type AggregateFn,
  type AggregateQuery,
  type AggregateQueryResult,
  type AggregateTerm,
  type OrderTerm,
  type PageToken,
  type ParsedQuery,
  type ParsedQueryResult,
  type Predicate,
  type QueryParams,
  type QueryTableSchema,
  type QueryValue,
  type RowQuery,
  type RowQueryResult,
  type WhereClause,
} from "@starkeep/storage-adapter";
