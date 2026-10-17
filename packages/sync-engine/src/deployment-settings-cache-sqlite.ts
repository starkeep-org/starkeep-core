import type { RawDatabase } from "@starkeep/storage-adapter";
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
} from "kysely";
import type { DeploymentSettingsCache } from "./library-settings.js";

// Compile-only Kysely instance (DummyDriver never executes); statements run
// synchronously through the raw handle's prepare().
type DB = Record<string, Record<string, unknown>>;
const qb = new Kysely<DB>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

const TABLE = "deployment_settings_cache";

/**
 * The last good read of the deployment's settings, in the node's own database.
 * One row. `document_json` holds the JSON text the source answered, `null`
 * included, which is how "no document is set" survives a restart.
 */
export function createSqliteDeploymentSettingsCache(options: {
  readonly db: RawDatabase;
}): DeploymentSettingsCache {
  const { db } = options;
  db.exec(
    qb.schema
      .createTable(TABLE)
      .ifNotExists()
      .addColumn("id", "integer", (c) => c.primaryKey())
      .addColumn("document_json", "text", (c) => c.notNull())
      .compile().sql,
  );
  const getStmt = db.prepare(
    qb.selectFrom(TABLE).select("document_json").where("id", "=", sql.lit(0)).compile().sql,
  );
  const setStmt = db.prepare(
    qb
      .insertInto(TABLE)
      .values({ id: sql.lit(0), document_json: sql.raw("?") })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet((eb) => ({ document_json: eb.ref("excluded.document_json") })),
      )
      .compile().sql,
  );
  return {
    load() {
      const row = getStmt.get() as { document_json: string } | undefined;
      if (!row) return undefined;
      try {
        return { document: JSON.parse(row.document_json) as unknown };
      } catch {
        return undefined;
      }
    },
    save(document) {
      setStmt.run(JSON.stringify(document));
    },
  };
}
