import type { PGlite } from "@electric-sql/pglite";

/**
 * Drops every user schema in a PGlite database, leaving it as a fresh boot left
 * it, so a test file can boot PGlite once in `beforeAll` (a cold boot is about a
 * second) and re-run its seed in each `beforeEach` in tens of milliseconds.
 * Dropping beats truncating because tests create schemas and tables of their
 * own, and re-running the seed's DDL on an empty database rebuilds exactly what
 * a fresh boot would get; the system schemas and `public` are kept. This file
 * is duplicated in admin-installer, builtin-cloud-data-server and
 * storage-aurora-dsql because the only shared test package, `@starkeep/testkit`,
 * depends on `@starkeep/admin-installer`, so a shared helper there would create
 * a dependency cycle for admin-installer.
 */
export async function dropAllUserSchemas(pg: PGlite): Promise<void> {
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
