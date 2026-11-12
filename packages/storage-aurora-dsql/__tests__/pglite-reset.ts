import type { PGlite } from "@electric-sql/pglite";

/**
 * Returns a PGlite database to the state a fresh boot left it, so a test file
 * can boot PGlite once in `beforeAll` (a cold boot is about a second) and re-run
 * its seed in each `beforeEach` in tens of milliseconds.
 *
 * It first rolls back any transaction the previous test left open. With one
 * connection per file, a test that fails between its `BEGIN` and its `ROLLBACK`
 * would otherwise leak that transaction into the next test, whose drop and
 * reseed then run inside it, and once anything in there errors every remaining
 * test fails with "current transaction is aborted". `ROLLBACK` with no open
 * transaction only warns.
 *
 * It then drops every user schema. Dropping beats truncating because tests
 * create schemas and tables of their own, and re-running the seed's DDL on an
 * empty database rebuilds exactly what a fresh boot would get; the system
 * schemas and `public` are kept.
 *
 * admin-installer and builtin-cloud-data-server import this file by relative
 * path, as they already do `pg-shared-schema.ts`: the only shared test package,
 * `@starkeep/testkit`, depends on `@starkeep/admin-installer`, so a helper there
 * would create a dependency cycle, and a relative test import adds no package
 * dependency.
 */
export async function dropAllUserSchemas(pg: PGlite): Promise<void> {
  await pg.exec("ROLLBACK");
  const { rows } = await pg.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace
     WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'public')
       AND nspname NOT LIKE 'pg\\_toast%'
       AND nspname NOT LIKE 'pg\\_temp%'`,
  );
  for (const { nspname } of rows) {
    await pg.exec(`DROP SCHEMA "${nspname.replaceAll('"', '""')}" CASCADE`);
  }
}
