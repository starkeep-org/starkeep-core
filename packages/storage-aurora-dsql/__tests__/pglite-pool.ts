import { PGlite } from "@electric-sql/pglite";
import { dropAllUserSchemas } from "./pglite-reset.js";

/**
 * A file-level pool of PGlite databases for the conformance suites, so a case
 * does not pay a PGlite cold boot (about a second) for each database it needs.
 * `takeDatabase` hands out the next unused one, booting another only when none
 * is free, and resets it with `dropAllUserSchemas` before the harness re-runs
 * its DDL; that also undoes `breakReads`. Every database goes back to the pool
 * when the suite calls `releaseAll` after each case, so the pool settles at the
 * most databases one case holds: two in the applier suite, for a case and its
 * `peer()`.
 */
export function createDatabasePool() {
  const pool: { ready: Promise<PGlite>; inUse: boolean }[] = [];

  return {
    async takeDatabase(): Promise<PGlite> {
      let slot = pool.find((s) => !s.inUse);
      if (!slot) {
        const pg = new PGlite();
        slot = { ready: pg.waitReady.then(() => pg), inUse: false };
        pool.push(slot);
      }
      // Claimed before the first await, so concurrent callers never share a slot.
      slot.inUse = true;
      const pg = await slot.ready;
      await dropAllUserSchemas(pg);
      return pg;
    },

    /** Returns every database to the pool; for `afterEach`. */
    releaseAll(): void {
      for (const slot of pool) slot.inUse = false;
    },

    /** Closes every database and empties the pool; for `afterAll`. */
    async closeAll(): Promise<void> {
      await Promise.all(pool.splice(0).map(async (slot) => (await slot.ready).close()));
    },
  };
}
