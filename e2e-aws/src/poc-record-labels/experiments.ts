/**
 * The experiments that decide row-per-key (A) vs jsonb-per-(record,app) (B).
 *
 * Each returns a plain result object; `run.ts` prints the report. Nothing here
 * asserts — the point is to find out what DSQL actually does, including where
 * it refuses.
 */

import type pg from "pg";
import { connect, timeIt, tryQuery } from "./connect.js";
import { SCHEMA } from "./schema.js";
import { recordId, N_RECORDS } from "./seed.js";

export interface Probe {
  what: string;
  ok: boolean;
  detail: string;
}

/**
 * E1 — Do the jsonb partial-update operators actually work on DSQL? This is the
 * premise of design B: modify one key without rewriting the caller's view of
 * the others.
 */
export async function e1JsonbOperators(client: pg.Client): Promise<Probe[]> {
  const out: Probe[] = [];
  const rid = "probe_jsonb_ops";
  await tryQuery(client, `DELETE FROM ${SCHEMA}.labels_json WHERE record_id = $1`, [rid]);
  await client.query(
    `INSERT INTO ${SCHEMA}.labels_json
       (record_id, app_id, labels, record_type, created_at, updated_at, node_id)
     VALUES ($1,'alpha','{"a":1,"b":"two"}','image/jpeg','t0','t0','nodeA')`,
    [rid],
  );

  const cases: { what: string; sql: string; expect?: (rows: unknown[]) => string }[] = [
    {
      what: "jsonb_set — set one key, others untouched",
      sql: `UPDATE ${SCHEMA}.labels_json
              SET labels = jsonb_set(labels, '{c}', '"three"', true)
            WHERE record_id = '${rid}' AND app_id = 'alpha'
            RETURNING labels`,
    },
    {
      what: "|| merge — add/overwrite several keys at once",
      sql: `UPDATE ${SCHEMA}.labels_json
              SET labels = labels || '{"d":true,"a":99}'::jsonb
            WHERE record_id = '${rid}' AND app_id = 'alpha'
            RETURNING labels`,
    },
    {
      what: "- operator — retract one key",
      sql: `UPDATE ${SCHEMA}.labels_json
              SET labels = labels - 'b'
            WHERE record_id = '${rid}' AND app_id = 'alpha'
            RETURNING labels`,
    },
    {
      what: "? operator — key-exists predicate",
      sql: `SELECT labels ? 'c' AS has FROM ${SCHEMA}.labels_json
             WHERE record_id = '${rid}' AND app_id = 'alpha'`,
    },
    {
      what: "@> operator — containment predicate",
      sql: `SELECT labels @> '{"a":99}'::jsonb AS contains FROM ${SCHEMA}.labels_json
             WHERE record_id = '${rid}' AND app_id = 'alpha'`,
    },
    {
      what: "jsonb_object_keys — enumerate keys",
      sql: `SELECT string_agg(k, ',' ORDER BY k) AS keys
              FROM ${SCHEMA}.labels_json,
                   LATERAL jsonb_object_keys(labels) AS k
             WHERE record_id = '${rid}' AND app_id = 'alpha'`,
    },
    {
      what: "INSERT .. ON CONFLICT DO UPDATE with || (idempotent key merge)",
      sql: `INSERT INTO ${SCHEMA}.labels_json
              (record_id, app_id, labels, record_type, created_at, updated_at, node_id)
            VALUES ('${rid}','alpha','{"e":"five"}','image/jpeg','t1','t1','nodeA')
            ON CONFLICT (record_id, app_id) DO UPDATE
              SET labels = ${SCHEMA}.labels_json.labels || EXCLUDED.labels,
                  updated_at = EXCLUDED.updated_at
            RETURNING labels`,
    },
    {
      what: "jsonb_set_lax — set with null handling",
      sql: `UPDATE ${SCHEMA}.labels_json
              SET labels = jsonb_set_lax(labels, '{f}', NULL, true, 'use_json_null')
            WHERE record_id = '${rid}' AND app_id = 'alpha'
            RETURNING labels`,
    },
  ];

  for (const c of cases) {
    const res = await tryQuery(client, c.sql);
    out.push({
      what: c.what,
      ok: res.ok,
      detail: res.ok ? JSON.stringify(res.rows[0] ?? {}) : `${res.code ?? "?"}: ${res.message}`,
    });
  }
  await tryQuery(client, `DELETE FROM ${SCHEMA}.labels_json WHERE record_id = $1`, [rid]);
  return out;
}

/**
 * E2 — Can a jsonb column be indexed in any form? This is the crux: design B's
 * reverse lookup ("which records did app A label X") is only viable with an
 * index that can answer a key-existence predicate.
 */
export async function e2JsonbIndexing(client: pg.Client): Promise<Probe[]> {
  const attempts: { what: string; sql: string }[] = [
    {
      what: "b-tree on the jsonb column",
      sql: `CREATE INDEX ASYNC poc_idx_jsonb_plain ON ${SCHEMA}.labels_json (labels)`,
    },
    {
      what: "GIN on the jsonb column (PG's normal answer)",
      sql: `CREATE INDEX ASYNC poc_idx_jsonb_gin ON ${SCHEMA}.labels_json USING gin (labels)`,
    },
    {
      what: "GIN jsonb_path_ops",
      sql: `CREATE INDEX ASYNC poc_idx_jsonb_gin_path ON ${SCHEMA}.labels_json USING gin (labels jsonb_path_ops)`,
    },
    {
      what: "expression index on one extracted key",
      sql: `CREATE INDEX ASYNC poc_idx_jsonb_expr ON ${SCHEMA}.labels_json ((labels->>'ocr-available'))`,
    },
    {
      what: "covering index with jsonb as INCLUDE (non-key) column",
      sql: `CREATE INDEX ASYNC poc_idx_jsonb_include ON ${SCHEMA}.labels_json (app_id, record_id) INCLUDE (labels)`,
    },
  ];

  const out: Probe[] = [];
  for (const a of attempts) {
    const res = await tryQuery(client, a.sql);
    out.push({
      what: a.what,
      ok: res.ok,
      detail: res.ok ? "ACCEPTED" : `${res.code ?? "?"}: ${res.message}`,
    });
    if (res.ok) {
      // Clean up anything DSQL actually accepted so later timings aren't skewed.
      const name = a.sql.match(/ASYNC (\S+)/)?.[1];
      if (name) await tryQuery(client, `DROP INDEX IF EXISTS ${SCHEMA}.${name}`);
    }
  }
  return out;
}

export interface QueryResult {
  what: string;
  medianMs: number;
  rowCount: number;
  plan: string;
}

async function explain(client: pg.Client, sql: string, params: unknown[]): Promise<string> {
  const res = await tryQuery(client, `EXPLAIN ANALYZE ${sql}`, params);
  if (!res.ok) return `(EXPLAIN unavailable: ${res.message})`;
  return (res.rows as Record<string, string>[])
    .map((r) => Object.values(r)[0])
    .join("\n");
}

/**
 * E3 — The reverse lookup, at both selectivities. This is the query that
 * replaces "app B calls app A about every file".
 */
export async function e3ReverseLookup(client: pg.Client): Promise<QueryResult[]> {
  const runs = 5;
  const out: QueryResult[] = [];

  const queries: { what: string; sql: string; params: unknown[] }[] = [
    {
      what: "A (rows)  rare key   — indexed seek",
      sql: `SELECT record_id FROM ${SCHEMA}.labels_rows
             WHERE app_id = $1 AND key = $2 AND deleted_at IS NULL
             ORDER BY record_id LIMIT 50`,
      params: ["alpha", "needs-review"],
    },
    {
      what: "B (jsonb) rare key   — must scan",
      sql: `SELECT record_id FROM ${SCHEMA}.labels_json
             WHERE app_id = $1 AND labels ? $2 AND deleted_at IS NULL
             ORDER BY record_id LIMIT 50`,
      params: ["alpha", "needs-review"],
    },
    {
      what: "A (rows)  common key — indexed seek",
      sql: `SELECT record_id FROM ${SCHEMA}.labels_rows
             WHERE app_id = $1 AND key = $2 AND deleted_at IS NULL
             ORDER BY record_id LIMIT 50`,
      params: ["alpha", "ocr-available"],
    },
    {
      what: "B (jsonb) common key — scan, but matches early",
      sql: `SELECT record_id FROM ${SCHEMA}.labels_json
             WHERE app_id = $1 AND labels ? $2 AND deleted_at IS NULL
             ORDER BY record_id LIMIT 50`,
      params: ["alpha", "ocr-available"],
    },
    {
      what: "A (rows)  count rare key",
      sql: `SELECT count(*)::int AS n FROM ${SCHEMA}.labels_rows
             WHERE app_id = $1 AND key = $2 AND deleted_at IS NULL`,
      params: ["alpha", "needs-review"],
    },
    {
      what: "B (jsonb) count rare key",
      sql: `SELECT count(*)::int AS n FROM ${SCHEMA}.labels_json
             WHERE app_id = $1 AND labels ? $2 AND deleted_at IS NULL`,
      params: ["alpha", "needs-review"],
    },
  ];

  for (const q of queries) {
    let rowCount = 0;
    const ms = await timeIt(runs, async () => {
      const res = await client.query(q.sql, q.params as never);
      rowCount = res.rows.length;
    });
    out.push({ what: q.what, medianMs: ms, rowCount, plan: await explain(client, q.sql, q.params) });
  }
  return out;
}

/**
 * E4 — The forward path: hydrate all labels for one page of 50 records. This is
 * the query that runs on every listing, so it matters more than the reverse one.
 */
export async function e4ForwardLookup(client: pg.Client): Promise<QueryResult[]> {
  const page = Array.from({ length: 50 }, (_, i) => recordId(i * 7));
  const runs = 5;
  const out: QueryResult[] = [];

  const queries: { what: string; sql: string; params: unknown[] }[] = [
    {
      what: "A (rows)  labels for a 50-record page",
      sql: `SELECT record_id, app_id, key, value FROM ${SCHEMA}.labels_rows
             WHERE record_id = ANY($1) AND deleted_at IS NULL`,
      params: [page],
    },
    {
      what: "B (jsonb) labels for a 50-record page",
      sql: `SELECT record_id, app_id, labels FROM ${SCHEMA}.labels_json
             WHERE record_id = ANY($1) AND deleted_at IS NULL`,
      params: [page],
    },
  ];

  for (const q of queries) {
    let rowCount = 0;
    const ms = await timeIt(runs, async () => {
      const res = await client.query(q.sql, q.params as never);
      rowCount = res.rows.length;
    });
    out.push({ what: q.what, medianMs: ms, rowCount, plan: await explain(client, q.sql, q.params) });
  }
  return out;
}

/**
 * E5 — OCC contention. Design B collapses all of one app's keys for a record
 * into ONE row, so two concurrent writers of *different keys* now touch the same
 * row. Under DSQL's optimistic concurrency that is a commit-time conflict.
 * Design A gives each key its own row, so the same workload doesn't collide.
 */
export async function e5Concurrency(): Promise<Probe[]> {
  const out: Probe[] = [];
  const rid = "probe_occ";

  const setup = await connect();
  await tryQuery(setup, `DELETE FROM ${SCHEMA}.labels_json WHERE record_id = $1`, [rid]);
  await tryQuery(setup, `DELETE FROM ${SCHEMA}.labels_rows WHERE record_id = $1`, [rid]);
  await setup.query(
    `INSERT INTO ${SCHEMA}.labels_json
       (record_id, app_id, labels, record_type, created_at, updated_at, node_id)
     VALUES ($1,'alpha','{}','image/jpeg','t0','t0','nodeA')`,
    [rid],
  );
  await setup.end();

  // --- B: two concurrent jsonb_set of DIFFERENT keys on the SAME row --------
  {
    const c1 = await connect();
    const c2 = await connect();
    await c1.query("BEGIN");
    await c2.query("BEGIN");
    const r1 = await tryQuery(
      c1,
      `UPDATE ${SCHEMA}.labels_json SET labels = jsonb_set(labels,'{k1}','"v1"',true)
        WHERE record_id = $1 AND app_id = 'alpha'`,
      [rid],
    );
    const r2 = await tryQuery(
      c2,
      `UPDATE ${SCHEMA}.labels_json SET labels = jsonb_set(labels,'{k2}','"v2"',true)
        WHERE record_id = $1 AND app_id = 'alpha'`,
      [rid],
    );
    const commit1 = await tryQuery(c1, "COMMIT");
    const commit2 = await tryQuery(c2, "COMMIT");
    const both = commit1.ok && commit2.ok;
    out.push({
      what: "B (jsonb): concurrent jsonb_set of two DIFFERENT keys, same (record, app) row",
      ok: both,
      detail: both
        ? "both committed (no conflict)"
        : `conflict — stmt1=${r1.ok} stmt2=${r2.ok} commit1=${
            commit1.ok ? "ok" : `${commit1.code}: ${commit1.message}`
          } commit2=${commit2.ok ? "ok" : `${commit2.code}: ${commit2.message}`}`,
    });
    // Did a lost update occur, or did DSQL reject?
    const check = await connect();
    const final = await check.query(
      `SELECT labels FROM ${SCHEMA}.labels_json WHERE record_id = $1 AND app_id = 'alpha'`,
      [rid],
    );
    out.push({
      what: "B (jsonb): resulting row after the two concurrent writes",
      ok: true,
      detail: JSON.stringify(final.rows[0]),
    });
    await check.end();
    await c1.end();
    await c2.end();
  }

  // --- A: two concurrent inserts of DIFFERENT keys for the same (record, app)
  {
    const c1 = await connect();
    const c2 = await connect();
    await c1.query("BEGIN");
    await c2.query("BEGIN");
    const ins = (key: string) =>
      `INSERT INTO ${SCHEMA}.labels_rows
         (record_id, app_id, key, value, record_type, created_at, updated_at, node_id)
       VALUES ('${rid}','alpha','${key}',null,'image/jpeg','t0','t0','nodeA')
       ON CONFLICT (record_id, app_id, key) DO UPDATE SET updated_at = EXCLUDED.updated_at`;
    await tryQuery(c1, ins("k1"));
    await tryQuery(c2, ins("k2"));
    const commit1 = await tryQuery(c1, "COMMIT");
    const commit2 = await tryQuery(c2, "COMMIT");
    const both = commit1.ok && commit2.ok;
    out.push({
      what: "A (rows): concurrent writes of two DIFFERENT keys, same (record, app)",
      ok: both,
      detail: both
        ? "both committed (separate rows, no conflict)"
        : `conflict — commit1=${commit1.ok ? "ok" : commit1.message} commit2=${
            commit2.ok ? "ok" : commit2.message
          }`,
    });
    await c1.end();
    await c2.end();
  }

  // --- Control: B, two concurrent writers on DIFFERENT app rows -------------
  {
    const setupC = await connect();
    await tryQuery(
      setupC,
      `INSERT INTO ${SCHEMA}.labels_json
         (record_id, app_id, labels, record_type, created_at, updated_at, node_id)
       VALUES ($1,'gamma','{}','image/jpeg','t0','t0','nodeA')
       ON CONFLICT DO NOTHING`,
      [rid],
    );
    await setupC.end();
    const c1 = await connect();
    const c2 = await connect();
    await c1.query("BEGIN");
    await c2.query("BEGIN");
    await tryQuery(
      c1,
      `UPDATE ${SCHEMA}.labels_json SET labels = jsonb_set(labels,'{x}','"1"',true)
        WHERE record_id = $1 AND app_id = 'alpha'`,
      [rid],
    );
    await tryQuery(
      c2,
      `UPDATE ${SCHEMA}.labels_json SET labels = jsonb_set(labels,'{x}','"2"',true)
        WHERE record_id = $1 AND app_id = 'gamma'`,
      [rid],
    );
    const commit1 = await tryQuery(c1, "COMMIT");
    const commit2 = await tryQuery(c2, "COMMIT");
    out.push({
      what: "Control — B: concurrent writes by TWO DIFFERENT apps on the same record",
      ok: commit1.ok && commit2.ok,
      detail:
        commit1.ok && commit2.ok
          ? "both committed (app_id in the PK already separates apps in either design)"
          : `commit1=${commit1.ok ? "ok" : commit1.message} commit2=${commit2.ok ? "ok" : commit2.message}`,
    });
    await c1.end();
    await c2.end();
  }

  const cleanup = await connect();
  await tryQuery(cleanup, `DELETE FROM ${SCHEMA}.labels_json WHERE record_id = $1`, [rid]);
  await tryQuery(cleanup, `DELETE FROM ${SCHEMA}.labels_rows WHERE record_id = $1`, [rid]);
  await cleanup.end();
  return out;
}

/**
 * E6 — The 3,000-row transaction limit, and whether secondary indexes eat into
 * it. Decides how a bulk-labelling job has to batch, and corrects the guess in
 * the design doc.
 */
export async function e6TransactionLimits(client: pg.Client): Promise<Probe[]> {
  const out: Probe[] = [];
  const mk = (n: number, offset: number) =>
    Array.from({ length: n }, (_, i) => [
      `bulk_${String(offset + i).padStart(7, "0")}`,
      "alpha",
      "bulk-key",
      null,
      "image/jpeg",
      "t0",
      "t0",
      "nodeA",
      null,
    ]);

  const attempt = async (n: number, offset: number) => {
    const rows = mk(n, offset);
    const width = 9;
    const tuples = rows
      .map((_, r) => `(${Array.from({ length: width }, (_, c) => `$${r * width + c + 1}`).join(",")})`)
      .join(",");
    return tryQuery(
      client,
      `INSERT INTO ${SCHEMA}.labels_rows
         (record_id,app_id,key,value,record_type,created_at,updated_at,node_id,deleted_at)
       VALUES ${tuples} ON CONFLICT DO NOTHING`,
      rows.flat(),
    );
  };

  // labels_rows carries 2 secondary indexes; if index entries counted against
  // the 3,000 limit, 3,000 rows would fail.
  const at3000 = await attempt(3000, 1_000_000);
  out.push({
    what: "3,000-row INSERT into a table with 2 secondary indexes",
    ok: at3000.ok,
    detail: at3000.ok
      ? "accepted — index entries do NOT count against the 3,000-row limit"
      : `${at3000.code}: ${at3000.message}`,
  });

  const at3001 = await attempt(3001, 2_000_000);
  out.push({
    what: "3,001-row INSERT (expected to exceed the limit)",
    ok: at3001.ok,
    detail: at3001.ok ? "accepted (limit is higher than documented?)" : `${at3001.code}: ${at3001.message}`,
  });

  await tryQuery(client, `DELETE FROM ${SCHEMA}.labels_rows WHERE key = 'bulk-key'`);
  return out;
}

/** E7 — table sizes, for the storage/cost comparison. */
export async function e7Sizes(client: pg.Client): Promise<Probe[]> {
  const out: Probe[] = [];
  for (const t of ["labels_rows", "labels_json"]) {
    const res = await tryQuery(
      client,
      `SELECT count(*)::int AS rows FROM ${SCHEMA}.${t} WHERE deleted_at IS NULL`,
    );
    out.push({
      what: `${t} live row count (same logical data, ${N_RECORDS} records)`,
      ok: res.ok,
      detail: res.ok ? JSON.stringify(res.rows[0]) : res.message,
    });
  }
  return out;
}
