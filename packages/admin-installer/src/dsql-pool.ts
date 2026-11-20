/**
 * The one way the installer opens a `pg.Pool` against Aurora DSQL.
 *
 * Two failures happen when a DSQL connection dies quietly (STA-102):
 *
 * - `pg.Pool` re-emits a client's socket error as a pool `error` event. That
 *   includes a client the pool has already ended: pg-pool's `_remove` keeps the
 *   idle listener attached while `client.end()` runs. With no pool listener,
 *   Node treats the event as unhandled and crashes the process, for example
 *   with `read ETIMEDOUT` after an uninstall has finished.
 * - `pool.end()` resolves before its clients' sockets close. A dead socket
 *   never answers the Terminate message, so it holds the process open until
 *   the operating system times the read out, which takes minutes.
 *
 * `createDsqlPool` downgrades pool errors to a warning. The pool drops the
 * dead client, and the next query acquires a fresh one. A failed query still
 * rejects on its own. Each client also destroys its socket if a close does not
 * finish within the grace period.
 */
import pg from "pg";

/** How long a closing connection may wait for the server before its socket is destroyed. */
export const DSQL_CLOSE_GRACE_MS = 2_000;

export interface DsqlPoolOptions {
  /** Names the pool in warnings, for example the cluster hostname. */
  label: string;
  /** Overrides {@link DSQL_CLOSE_GRACE_MS}. Tests use a short value. */
  closeGraceMs?: number;
}

export function createDsqlPool(config: pg.PoolConfig, options: DsqlPoolOptions): pg.Pool {
  const closeGraceMs = options.closeGraceMs ?? DSQL_CLOSE_GRACE_MS;

  class DsqlClient extends pg.Client {
    override end(): Promise<void>;
    override end(callback: (err: Error) => void): void;
    override end(callback?: (err: Error) => void): Promise<void> | void {
      const stream = this.connection.stream;
      // unref: a clean close lets the process exit without waiting for the timer.
      const timer = setTimeout(() => stream.destroy(), closeGraceMs).unref();
      this.once("end", () => clearTimeout(timer));
      return callback ? super.end(callback) : super.end();
    }
  }

  const pool = new pg.Pool({ ...config, Client: DsqlClient });
  pool.on("error", (err) => {
    console.warn(
      `[diag] idle DSQL connection error (${options.label}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
  return pool;
}
