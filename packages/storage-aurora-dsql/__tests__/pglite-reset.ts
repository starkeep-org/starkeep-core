import type { PGlite } from "@electric-sql/pglite";

/**
 * Drops every user schema in a PGlite database, leaving it as a fresh boot
 * left it, so a test file can boot PGlite once in `beforeAll` and re-run its
 * seed in each `beforeEach` instead of booting per test (a cold boot is about
 * a second; dropping and re-seeding is tens of milliseconds).
 *
 * Dropping, not truncating: tests create schemas and tables of their own and
 * delete seeded rows, and re-running the seed's DDL on an empty database
 * rebuilds exactly what a fresh boot would get. Kept are the system schemas
 * (`pg_catalog`, `information_schema`, `pg_toast*`, `pg_temp*`) and `public`,
 * which the seeds do not write to.
 *
 * storage-aurora-dsql (C2) and admin-installer (C3) copy this file verbatim
 * into their own `__tests__/`; the duplication is accepted so each package's
 * test files stay in its own area (AI-705).
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
