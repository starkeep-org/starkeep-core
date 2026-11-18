/**
 * Two users, one database: no join, subquery or column operand reaches the
 * other user's rows.
 *
 * The owner-scope plugin needs no new code for these forms: it scopes every
 * joined table in its `on` and every nested select in its own `where`. This
 * file proves that for the grammar rather than inferring it.
 *
 * User B holds the same rows as user A under the same ids, plus rows that
 * would change A's answers if they leaked: a task in A's empty project `p3`,
 * and a comment on A's uncommented task `t3`. Every join case of the
 * conformance suite then runs as A and must return exactly what it returns
 * for a database A has to itself. A leaked join row shows up as a duplicate,
 * and a leaked subquery row as a changed match.
 *
 * Every statement also passes two tripwires: `assertOwnerScoped`, and a count
 * that requires one owner predicate per owned table the statement names.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { pgColumnType, serializeHLC } from "@starkeep/protocol-primitives";
import type { AppSyncableNamespace, AppSyncableNamespaceStore } from "@starkeep/sync-engine";
import {
  appSyncableJoinConformance,
  JOIN_TABLES,
  seedJoinRows,
} from "@starkeep/storage-adapter/conformance/query";
import { DsqlAppSyncableApplier } from "../../src/app-syncable/apply.js";
import { assertOwnerScoped } from "../../src/owner-scope.js";
import { PG_RAW_PARSERS } from "../../src/pg-timestamps.js";
import type { DatabaseClient } from "../../src/types.js";
import { createAppNodeWatermarks } from "../pg-shared-schema.js";
import { dropAllUserSchemas } from "../pglite-reset.js";
import { guardNodeWatermarks } from "../../src/node-watermarks.js";
import { guardSingleFlight } from "../../src/single-flight.js";

const A = "user-a";
const B = "user-b";
const APP = "planner";
const SCHEMA = "app_planner";

let pg: PGlite;
/** Every SELECT the appliers ran, for the per-table owner count. */
const selects: string[] = [];

/** An owned table, not a column qualified by one. */
const OWNED_TABLE = /"app_[a-z0-9_]+"\."[^"]+"(?!\.)/g;
const OWNER_PREDICATE = /"user_id" = \$\d+/g;

function client(): DatabaseClient {
  return guardSingleFlight(
    guardNodeWatermarks({
      async query(text, values) {
        assertOwnerScoped(text);
        if (/^\s*select/i.test(text)) selects.push(text);
        const result = await pg.query(text, values as unknown[] | undefined, {
          parsers: PG_RAW_PARSERS,
        });
        return { rows: result.rows as Record<string, unknown>[] };
      },
      async end() {},
    }),
    { onOverlap: "throw" },
  );
}

const ns: AppSyncableNamespace = {
  appId: APP,
  tables: JOIN_TABLES.map((t) => ({
    name: t.name,
    pkColumns: [...t.pkColumns],
    columns: t.columns,
  })),
  filesEnabled: false,
  tableNames: JOIN_TABLES.map((t) => t.name),
};
const namespaces: AppSyncableNamespaceStore = {
  get: (id) => (id === APP ? ns : null),
  list: () => [ns],
};

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await dropAllUserSchemas(pg);
  const ddl = JOIN_TABLES.map((t) => {
    const columns = [
      "user_id TEXT NOT NULL",
      ...t.columns.map(
        (c) => `${c.name} ${pgColumnType(c.type)}${c.primaryKey ? " NOT NULL" : ""}`,
      ),
      `PRIMARY KEY (user_id, ${t.pkColumns.join(", ")})`,
    ];
    return `CREATE TABLE ${SCHEMA}.${t.name} (${columns.join(", ")});`;
  }).join("\n");
  await pg.exec(`CREATE SCHEMA ${SCHEMA};\n${ddl}`);
  await createAppNodeWatermarks(pg, SCHEMA);
  selects.length = 0;
});

/** B's copy of A's rows, plus the rows that would change A's answers if they leaked. */
async function seedUserB(): Promise<void> {
  const b = new DsqlAppSyncableApplier(client(), namespaces, B);
  await seedJoinRows({ applier: b, appId: APP });
  const bait = [
    {
      table: "tasks",
      row: {
        id: "t8",
        project_id: "p3",
        parent_task_id: "t1",
        title: "bait",
        done: true,
        estimate: 1,
        due: "2026-09-20T00:00:00.000Z",
      },
    },
    { table: "comments", row: { id: "c8", task_id: "t3", author: "bob" } },
  ];
  let clock = 1000;
  for (const { table, row } of bait) {
    const ts = { wallTime: clock++, counter: 0, nodeId: "node-b" };
    await b.apply({
      timestamp: ts,
      appId: APP,
      table,
      op: "insert",
      row: { ...row, updated_at: serializeHLC(ts), deleted_at: null },
    });
  }
}

describe("joins, subqueries and column operands across two users", () => {
  for (const testCase of appSyncableJoinConformance) {
    it(`returns none of the other user's rows: ${testCase.name}`, async () => {
      await seedUserB();
      selects.length = 0;
      const a = new DsqlAppSyncableApplier(client(), namespaces, A);
      await testCase.run({ applier: a, appId: APP });

      const queries = selects.filter((text) => text.includes(`"${SCHEMA}".`));
      expect(queries.length).toBeGreaterThan(0);
      for (const text of queries) {
        const tables = text.match(OWNED_TABLE)?.length ?? 0;
        const owners = text.match(OWNER_PREDICATE)?.length ?? 0;
        expect(owners, text).toBeGreaterThanOrEqual(tables);
      }
    });
  }
});
