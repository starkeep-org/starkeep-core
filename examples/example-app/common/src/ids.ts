/**
 * The names every flavor of the example app must agree on.
 *
 * The manifest declares the same names, so a change here needs the matching
 * change in `starkeep.manifest.json`. The web flavor's tests check the two
 * agree.
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
} as const;

/** The app's own tables, as the manifest declares them. */
export const TABLES = {
  notes: "notes",
} as const;

/** Where the app keeps its private snapshot files. */
export const SNAPSHOT_PREFIX = "snapshots/";
