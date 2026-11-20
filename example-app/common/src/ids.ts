/**
 * The names every flavor of the example app must agree on.
 *
 * The manifest declares the same names, so a change here needs the matching
 * change in `starkeep.manifest.json`. `common/__tests__/manifest.test.ts`
 * checks the two agree.
 */

/** The app id: it namespaces the app's labels and its own tables. */
export const APP_ID = "example-app";

/**
 * The one shared type the app reads and writes. The `example` category exists
 * only for this app, so its files never mix with a person's real ones.
 */
export const EXAMPLE_TYPE = "example/plaintext";

/** The category of {@link EXAMPLE_TYPE}, which names its metadata table. */
export const EXAMPLE_CATEGORY = "example";

/** The file extension the local watcher maps to {@link EXAMPLE_TYPE}. */
export const EXAMPLE_EXTENSION = "skexample";

/** The label keys the manifest declares. */
export const LABEL_KEYS = {
  /** A set-valued tag, such as `draft` or `idea`. */
  tag: "tag",
  /** A bare flag: present or absent, with no value. */
  reviewed: "reviewed",
  /** Marks a derived copy, valued with how it was made. */
  derived: "derived",
  /** A bare flag on every file the Load sample data button made. */
  sample: "sample",
} as const;

/** The app's own tables, as the manifest declares them. */
export const TABLES = {
  notes: "notes",
  /** Named groups of example files. */
  collections: "collections",
  /** Which file sits in which collection, one row per pair. */
  collectionItems: "collection_items",
} as const;

/** Where the app keeps its private note-export files. */
export const EXPORT_PREFIX = "exports/";

/** The background jobs the manifest declares. */
export const JOBS = {
  /** Writes a digest of the user's example files and notes as a new file. */
  digest: "digest",
} as const;

/** The credential vault secrets the app keeps for each user. */
export const SECRETS = {
  /** A token for the example's stand-in third-party provider. */
  providerToken: "provider-token",
} as const;
