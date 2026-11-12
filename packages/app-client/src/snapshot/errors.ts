/**
 * The failures the snapshot helper reports, as classes an app's route can map
 * to a response.
 *
 * Two carry an HTTP status because each one has a natural answer for the
 * browser: a refused caller is the caller's problem, and a failed load is the
 * data server's. The other two are the app's own bugs or limits and have no
 * status a browser could act on.
 */

/** The request may not read this app's data: another site, no session, or no credential. */
export class SnapshotAccessError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 | 503,
  ) {
    super(message);
    this.name = "SnapshotAccessError";
  }
}

/** The data server refused or failed a page of the load. */
export class SnapshotLoadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SnapshotLoadError";
  }
}

/** The named tables hold more rows than the cache allows in one snapshot. */
export class SnapshotTooLargeError extends Error {
  constructor(readonly maxRows: number) {
    super(
      `the snapshot would hold more than ${maxRows} rows; raise maxRows or aggregate ` +
        `on the data server with the row grammar instead`,
    );
    this.name = "SnapshotTooLargeError";
  }
}

/** The statement is not a read, or it changed the snapshot. */
export class SnapshotReadOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotReadOnlyError";
  }
}
