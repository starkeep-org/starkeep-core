/**
 * Step 0c of the cross-app-record-labels plan: verify the *shape* of the
 * reverse index against a real DSQL cluster before the DDL commits to it.
 *
 * §4 proposes `(app_id, key, deleted_at, value, record_id) INCLUDE (record_type)`
 * and rests it on two DSQL behaviours the plan asserts but had not measured:
 *
 *   Q1 — is `INCLUDE` accepted on a regular b-tree here?
 *   Q2 — is `deleted_at IS NULL` planned as a **scan key** (cutting the range)
 *        rather than a filter applied to rows inside it?
 *
 * Neither gets a free pass: §3a is a record of DSQL rejecting four index shapes
 * plain Postgres accepts (b-tree on jsonb, gin, gin/jsonb_path_ops, expression
 * indexes) and having no partial indexes at all.
 *
 * Q2 is answered by *contrast*, not by reading the plan text — planners word
 * things differently and `Index Cond` vs `Filter` is not always decisive on a
 * fork. Two tables hold identical data and differ only in whether `deleted_at`
 * is a key column of the reverse index. Both are seeded with a key whose live
 * rows are a tiny minority of a large tombstone pile. If `IS NULL` cuts the
 * range, the table that indexes it stays flat while the control degrades in
 * proportion to the tombstones; if it is a filter applied within the range,
 * the two match and §4's fallback applies.
 */

import type pg from "pg";
import { tryQuery, timeIt } from "./connect.js";
import { SCHEMA } from "./schema.js";
import type { Probe, QueryResult } from "./experiments.js";

/** Live rows carrying the churned key — the rows a reverse query wants. */
export const LIVE_COUNT = 20;
/** Retracted rows on that same key, i.e. the tombstone pile queries must not walk. */
export const TOMBSTONE_COUNT = 20_000;

const BATCH = 1_000;

const rid = (i: number) => `rev_${String(i).padStart(6, "0")}`;
const hlc = (i: number) => `2026-07-27T12:00:00.000Z:${String(i).padStart(6, "0")}:nodeA`;

/**
 * Two tables, identical in every way except the reverse index. `final` is §4's
 * proposal; `ctl` is the same index with `deleted_at` removed, which is also
 * exactly §4's fallback shape if Q2 comes back negative.
 */
const TABLES = ["labels_final", "labels_ctl"] as const;

function tableDdl(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${SCHEMA}.${name} (
            record_id   text not null,
            app_id      text not null,
            key         text not null,
            value       text,
            record_type text not null,
            created_at  text not null,
            updated_at  text not null,
            node_id     text not null,
            deleted_at  text,
            primary key (record_id, app_id, key)
          )`;
}

/**
 * Index candidates, most-preferred first. Q1 is answered by which of these
 * DSQL accepts: if `INCLUDE` is rejected, the trailing-key-column variant is
 * §4's stated fallback and carries `record_type` in the index just as well.
 */
const REVERSE_CANDIDATES = [
  {
    name: "include",
    describe: "(app_id, key, deleted_at, value, record_id) INCLUDE (record_type)",
    sql: (t: string, idx: string) =>
      `CREATE INDEX ASYNC ${idx} ON ${SCHEMA}.${t} (app_id, key, deleted_at, value, record_id) INCLUDE (record_type)`,
  },
  {
    name: "trailing-key",
    describe: "(app_id, key, deleted_at, value, record_id, record_type)",
    sql: (t: string, idx: string) =>
      `CREATE INDEX ASYNC ${idx} ON ${SCHEMA}.${t} (app_id, key, deleted_at, value, record_id, record_type)`,
  },
];

/** The control drops `deleted_at`, mirroring whichever candidate won. */
const CONTROL_CANDIDATES = [
  {
    name: "include",
    sql: (t: string, idx: string) =>
      `CREATE INDEX ASYNC ${idx} ON ${SCHEMA}.${t} (app_id, key, value, record_id) INCLUDE (record_type)`,
  },
  {
    name: "trailing-key",
    sql: (t: string, idx: string) =>
      `CREATE INDEX ASYNC ${idx} ON ${SCHEMA}.${t} (app_id, key, value, record_id, record_type)`,
  },
];

async function indexExists(client: pg.Client, name: string): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`,
    [SCHEMA, name],
  );
  return res.rows.length > 0;
}

async function waitForIndex(client: pg.Client, name: string): Promise<boolean> {
  for (let i = 0; i < 90; i++) {
    const res = await client.query(
      `SELECT indisvalid FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = $1`,
      [name],
    );
    if (res.rows[0]?.indisvalid === true) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/**
 * Q1 — create the tables and find out which reverse-index shape DSQL accepts.
 * Returns the winning variant so the query experiment knows what it measured.
 */
export async function q1CreateIndexes(
  client: pg.Client,
): Promise<{ probes: Probe[]; variant: string | null }> {
  const probes: Probe[] = [];

  for (const t of TABLES) {
    const res = await tryQuery(client, tableDdl(t));
    probes.push({
      what: `table ${t}`,
      ok: res.ok,
      detail: res.ok ? "created" : `${res.code ?? "?"}: ${res.message}`,
    });
    if (!res.ok) return { probes, variant: null };
  }

  // Try each reverse shape in preference order against the primary table.
  let variant: string | null = null;
  for (const cand of REVERSE_CANDIDATES) {
    const idx = `poc_idx_final_${cand.name}`;
    if (await indexExists(client, idx)) {
      probes.push({ what: `Q1 ${cand.describe}`, ok: true, detail: "accepted (already exists)" });
      variant = cand.name;
      break;
    }
    const res = await tryQuery(client, cand.sql("labels_final", idx));
    if (res.ok) {
      const valid = await waitForIndex(client, idx);
      probes.push({
        what: `Q1 ${cand.describe}`,
        ok: true,
        detail: `ACCEPTED${valid ? "" : " (WARNING: not valid within budget)"}`,
      });
      variant = cand.name;
      break;
    }
    probes.push({
      what: `Q1 ${cand.describe}`,
      ok: false,
      detail: `REJECTED — ${res.code ?? "?"}: ${res.message}`,
    });
  }

  if (!variant) return { probes, variant: null };

  // Control table gets the matching shape minus `deleted_at`.
  const ctl = CONTROL_CANDIDATES.find((c) => c.name === variant)!;
  const ctlIdx = `poc_idx_ctl_${variant}`;
  if (!(await indexExists(client, ctlIdx))) {
    const res = await tryQuery(client, ctl.sql("labels_ctl", ctlIdx));
    if (!res.ok) {
      probes.push({
        what: "control index (same shape, no deleted_at)",
        ok: false,
        detail: `${res.code ?? "?"}: ${res.message}`,
      });
      return { probes, variant: null };
    }
    const valid = await waitForIndex(client, ctlIdx);
    probes.push({
      what: "control index (same shape, no deleted_at)",
      ok: true,
      detail: `created${valid ? "" : " (WARNING: not valid within budget)"}`,
    });
  } else {
    probes.push({ what: "control index (same shape, no deleted_at)", ok: true, detail: "exists" });
  }

  return { probes, variant };
}

/**
 * Seed both tables identically: one key whose live rows are swamped by
 * tombstones. That ratio is what makes Q2 answerable — the two tables can only
 * diverge if `deleted_at` in the index is keeping the tombstones out of the
 * scanned range.
 */
export async function seedChurn(client: pg.Client): Promise<{ live: number; dead: number }> {
  const cols =
    "record_id, app_id, key, value, record_type, created_at, updated_at, node_id, deleted_at";

  const existing = await client.query(
    `SELECT count(*)::int AS n FROM ${SCHEMA}.labels_final`,
  );
  if ((existing.rows[0] as { n: number }).n > 0) {
    console.log("  · churn data already seeded — skipping");
  } else {
    for (const t of TABLES) {
      let batch: unknown[][] = [];
      const flush = async () => {
        if (batch.length === 0) return;
        const width = 9;
        const tuples = batch
          .map(
            (_, r) =>
              `(${Array.from({ length: width }, (_, c) => `$${r * width + c + 1}`).join(",")})`,
          )
          .join(",");
        await client.query(
          `INSERT INTO ${SCHEMA}.${t} (${cols}) VALUES ${tuples} ON CONFLICT DO NOTHING`,
          batch.flat() as never,
        );
        batch = [];
      };

      // Tombstones first, then the live rows, so the live rows are not
      // conveniently clustered at the front of the table's physical order.
      for (let i = 0; i < TOMBSTONE_COUNT; i++) {
        batch.push([
          rid(i), "alpha", "churned", null, "image/jpeg", hlc(i), hlc(i), "nodeA", hlc(i),
        ]);
        if (batch.length >= BATCH) await flush();
      }
      for (let i = 0; i < LIVE_COUNT; i++) {
        batch.push([
          rid(TOMBSTONE_COUNT + i), "alpha", "churned", null, "image/jpeg",
          hlc(i), hlc(i), "nodeA", null,
        ]);
        if (batch.length >= BATCH) await flush();
      }
      // A valued key too, so the `value`-pinned seek is measurable on real data.
      for (let i = 0; i < LIVE_COUNT; i++) {
        batch.push([
          rid(TOMBSTONE_COUNT + i), "alpha", "quality", i % 2 === 0 ? "high" : "low",
          "image/jpeg", hlc(i), hlc(i), "nodeA", null,
        ]);
        if (batch.length >= BATCH) await flush();
      }
      await flush();
    }
  }

  const live = await client.query(
    `SELECT count(*)::int AS n FROM ${SCHEMA}.labels_final WHERE deleted_at IS NULL`,
  );
  const dead = await client.query(
    `SELECT count(*)::int AS n FROM ${SCHEMA}.labels_final WHERE deleted_at IS NOT NULL`,
  );
  return {
    live: (live.rows[0] as { n: number }).n,
    dead: (dead.rows[0] as { n: number }).n,
  };
}

async function explain(client: pg.Client, sql: string, params: unknown[]): Promise<string> {
  const res = await tryQuery(client, `EXPLAIN ANALYZE ${sql}`, params);
  if (!res.ok) return `(EXPLAIN unavailable: ${res.message})`;
  return (res.rows as Record<string, string>[]).map((r) => Object.values(r)[0]).join("\n");
}

/**
 * Q2 — the same reverse query against both tables. The plan text is reported
 * for the record, but the *decision* is the timing contrast: `deleted_at` in
 * the index only earns its place if it makes the query independent of the
 * tombstone pile.
 */
export async function q2ScanKey(client: pg.Client): Promise<QueryResult[]> {
  const runs = 5;
  const out: QueryResult[] = [];

  const queries: { what: string; sql: string; params: unknown[] }[] = [
    {
      what: "final (deleted_at in index) — presence, flag key",
      sql: `SELECT record_id, record_type FROM ${SCHEMA}.labels_final
             WHERE app_id = $1 AND key = $2 AND deleted_at IS NULL
             ORDER BY value, record_id LIMIT 50`,
      params: ["alpha", "churned"],
    },
    {
      what: "ctl   (deleted_at not indexed) — presence, flag key",
      sql: `SELECT record_id, record_type FROM ${SCHEMA}.labels_ctl
             WHERE app_id = $1 AND key = $2 AND deleted_at IS NULL
             ORDER BY value, record_id LIMIT 50`,
      params: ["alpha", "churned"],
    },
    {
      what: "final — value-pinned seek (labelValue=)",
      sql: `SELECT record_id, record_type FROM ${SCHEMA}.labels_final
             WHERE app_id = $1 AND key = $2 AND deleted_at IS NULL AND value = $3
             ORDER BY record_id LIMIT 50`,
      params: ["alpha", "quality", "high"],
    },
    {
      what: "final — grant filter as an index condition",
      sql: `SELECT record_id, record_type FROM ${SCHEMA}.labels_final
             WHERE app_id = $1 AND key = $2 AND deleted_at IS NULL
               AND record_type = ANY($3)
             ORDER BY value, record_id LIMIT 50`,
      params: ["alpha", "churned", ["image/jpeg", "image/png"]],
    },
  ];

  for (const q of queries) {
    let rowCount = 0;
    const medianMs = await timeIt(runs, async () => {
      const res = await client.query(q.sql, q.params as never);
      rowCount = res.rows.length;
    });
    out.push({ what: q.what, medianMs, rowCount, plan: await explain(client, q.sql, q.params) });
  }

  return out;
}

export async function dropChurnSchema(client: pg.Client): Promise<void> {
  for (const t of TABLES) {
    await tryQuery(client, `DROP TABLE IF EXISTS ${SCHEMA}.${t}`);
  }
}
