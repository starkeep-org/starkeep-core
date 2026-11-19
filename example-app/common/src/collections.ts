/**
 * The `collections` and `collection_items` tables: named groups of example
 * files.
 *
 * A file can sit in several collections. `collection_items` holds one row per
 * pair, keyed by both columns, so adding a file twice writes one row and
 * removing it deletes by both. Both tables sync on the app's own channel, like
 * `notes`.
 */

/** A collection as the app's code handles it. */
export interface Collection {
  readonly id: string;
  readonly name: string;
  /** An archived collection keeps its files but takes no new ones. */
  readonly archived: boolean;
}

/** A `collections` row as the data plane stores it. */
export interface CollectionRow {
  readonly id: string;
  readonly name: string;
  readonly archived: boolean;
  readonly created_on: string;
}

/** A `collection_items` row as the data plane stores it. */
export interface CollectionItemRow {
  readonly collection_id: string;
  readonly record_id: string;
  readonly added_on: string;
}

export function decodeCollection(row: Record<string, unknown>): Collection {
  return {
    id: String(row["id"]),
    name: typeof row["name"] === "string" ? row["name"] : "",
    archived: row["archived"] === true,
  };
}
