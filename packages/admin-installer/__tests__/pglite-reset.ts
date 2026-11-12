/**
 * Resets a PGlite between tests by dropping every user schema, so a suite can
 * boot one PGlite per file (a WASM Postgres cold boot is ~1.3s) and still give
 * each test an empty database. The caller re-runs its own schema creation
 * after this; plain DDL on an empty database is exact and takes milliseconds.
 *
 * Copied verbatim into each package's `__tests__/` that needs it
 * (builtin-cloud-data-server, storage-aurora-dsql, admin-installer):
 * duplication is accepted so each package's test files stay disjoint.
 */
import type { PGlite } from "@electric-sql/pglite";

export async function dropAllUserSchemas(pg: PGlite): Promise<void> {
  const { rows } = await pg.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace
     WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'public')
       AND nspname NOT LIKE 'pg\\_toast%'
       AND nspname NOT LIKE 'pg\\_temp%'`,
  );
  for (const { nspname } of rows) {
    await pg.exec(`DROP SCHEMA "${nspname.replace(/"/g, '""')}" CASCADE`);
  }
}
