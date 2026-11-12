import { PGlite } from "@electric-sql/pglite";

/**
 * A file-level pool of PGlite databases for the conformance suites, so a case
 * does not pay a PGlite cold boot (about a second) for each database it needs.
 * `takeDatabase` hands out the next unused one, booting another only when none
 * is free, and resets it with `DROP SCHEMA ${schema} CASCADE` before the
 * harness re-runs its DDL. That schema is the only one the harnesses create,
 * and dropping it also undoes `breakReads`. Every database goes back to the
 * pool when the suite calls `releaseAll` after each case.
 *
 * `limit` is the most live databases a single case may hold. The applier suite
 * needs two (a case and its `peer()`); past the limit `takeDatabase` throws
 * rather than handing out a database another harness in the same case is still
 * using.
 */
export function createDatabasePool({ schema, limit }: { schema: string; limit: number }) {
  const pool: { ready: Promise<PGlite>; inUse: boolean }[] = [];

  return {
    async takeDatabase(): Promise<PGlite> {
      let slot = pool.find((s) => !s.inUse);
      if (!slot) {
        if (pool.length >= limit) {
          throw new Error(
            `a conformance case asked for more than ${limit} live databases; ` +
              "raise POOL_LIMIT if a nested peer() is now intended",
          );
        }
        const pg = new PGlite();
        slot = { ready: pg.waitReady.then(() => pg), inUse: false };
        pool.push(slot);
      }
      // Claimed before the first await, so concurrent callers never share a slot.
      slot.inUse = true;
      const pg = await slot.ready;
      await pg.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
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
