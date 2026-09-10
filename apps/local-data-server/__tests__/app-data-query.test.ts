/**
 * The query grammar, end to end through the real HTTP surface.
 *
 * The parser's unit tests cover what the grammar *admits*; the conformance
 * suite covers what the compiled SQL *means* on each engine. This covers the
 * seam between them — that a request parses, compiles, runs against SQLite and
 * comes back as the rows the caller asked for, with the truncation signal and
 * the cursor a caller has to be able to trust.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import { installApp, type InstalledApp } from "./helpers.js";

let server: LocalDataServer;
let app: InstalledApp;

/** Two decks of cards, so grouping has more than one group to find. */
const CARDS = [
  { id: "c1", deck_id: "d1", due: "2026-09-01T00:00:00.000Z", reps: 3, suspended: 0, tag: "alpha" },
  { id: "c2", deck_id: "d1", due: "2026-09-05T00:00:00.000Z", reps: 1, suspended: 0, tag: "beta" },
  { id: "c3", deck_id: "d1", due: null, reps: 0, suspended: 1, tag: "alpha" },
  { id: "c4", deck_id: "d2", due: "2026-09-03T00:00:00.000Z", reps: 7, suspended: 0, tag: "gamma" },
  { id: "c5", deck_id: "d2", due: "2026-09-09T00:00:00.000Z", reps: 2, suspended: 0, tag: "alpha" },
];

function q(params: Record<string, string>): string {
  const search = new URLSearchParams(params);
  return `/app-data/db/card_state?${search.toString()}`;
}

async function rows(params: Record<string, string>): Promise<{
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
  page_token: string | null;
}> {
  const res = await app.fetch(q(params));
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(body)}`);
  return body as never;
}

async function groups(params: Record<string, string>): Promise<{
  groups: Array<Record<string, unknown>>;
  truncated: boolean;
}> {
  const res = await app.fetch(q(params));
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(body)}`);
  return body as never;
}

async function rejected(params: Record<string, string>): Promise<string> {
  const res = await app.fetch(q(params));
  expect(res.status).toBe(400);
  return ((await res.json()) as { error: string }).error;
}

beforeAll(async () => {
  server = await startLocalDataServer();
  app = await installApp(server, {
    id: "grammar-app",
    name: "Grammar App",
    version: "1.0.0",
    tier: "community",
    infraRequirements: {
      appSpecificSyncable: {
        files: false,
        tables: [
          {
            name: "card_state",
            columns: [
              { name: "id", type: "text", primaryKey: true, notNull: true },
              { name: "deck_id", type: "text" },
              // Declared `timestamp`, so the platform can promise that lexical
              // comparison is time comparison rather than leaving it to the
              // app's discipline.
              { name: "due", type: "timestamp" },
              { name: "reps", type: "integer" },
              { name: "suspended", type: "integer" },
              { name: "tag", type: "text" },
            ],
          },
        ],
      },
    },
  });
  for (const row of CARDS) {
    const res = await app.fetch("/app-data/db/card_state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ row }),
    });
    if (!res.ok) throw new Error(`seed failed: ${await res.text()}`);
  }
}, 60_000);

afterAll(async () => {
  await server.stop();
});

describe("filtering and projection", () => {
  it("filters, projects and orders in one request", async () => {
    const body = await rows({
      where: JSON.stringify({ deck_id: "d1", suspended: 0 }),
      select: "id,due",
      order: "due.asc",
    });
    expect(body.rows).toEqual([
      { id: "c1", due: "2026-09-01T00:00:00.000Z" },
      { id: "c2", due: "2026-09-05T00:00:00.000Z" },
    ]);
    // The projection is honoured exactly: the ordering column rode back under
    // a reserved alias and was stripped before the row went on the wire.
    expect(Object.keys(body.rows[0]!)).toEqual(["id", "due"]);
  });

  it("compares timestamps as instants", async () => {
    const body = await rows({
      where: JSON.stringify({ due: { lte: "2026-09-03T00:00:00.000Z" } }),
      select: "id",
      order: "id.asc",
    });
    expect(body.rows.map((r) => r.id)).toEqual(["c1", "c4"]);
  });

  it("puts nulls where the caller says, not where the engine prefers", async () => {
    // SQLite sorts nulls first and Postgres sorts them last, so neither
    // default is the answer — the grammar states it on every key.
    const last = await rows({ select: "id", order: "due.asc.nullslast" });
    expect(last.rows.map((r) => r.id).at(-1)).toBe("c3");
    const first = await rows({ select: "id", order: "due.asc.nullsfirst" });
    expect(first.rows.map((r) => r.id).at(0)).toBe("c3");
  });

  it("includes the null bucket in `ne`, which bare SQL would drop", async () => {
    // `deck_id <> 'd1'` excludes nulls on both engines, and a caller asking
    // for "not d1" means every row that is not d1.
    const body = await rows({
      where: JSON.stringify({ tag: { ne: "alpha" } }),
      select: "id",
      order: "id.asc",
    });
    expect(body.rows.map((r) => r.id)).toEqual(["c2", "c4"]);
  });

  it("seeks a prefix as a range", async () => {
    const body = await rows({
      where: JSON.stringify({ due: { prefix: "2026-09-0" } }),
      select: "id",
      order: "id.asc",
    });
    expect(body.rows.map((r) => r.id)).toEqual(["c1", "c2", "c4", "c5"]);
  });

  it("matches a wildcard pattern, which the engine evaluates", async () => {
    const body = await rows({
      where: JSON.stringify({ deck_id: "d1", tag: { like: "al%" } }),
      select: "id",
      order: "id.asc",
    });
    expect(body.rows.map((r) => r.id)).toEqual(["c1", "c3"]);
  });

  it("matches a substring, which prefix cannot express", async () => {
    const body = await rows({
      where: JSON.stringify({ tag: { like: "%ph%" } }),
      select: "id",
      order: "id.asc",
    });
    expect(body.rows.map((r) => r.id)).toEqual(["c1", "c3", "c5"]);
  });
});

describe("paging", () => {
  it("reports truncation and continues from the cursor without repeating a row", async () => {
    const seen: unknown[] = [];
    let token: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const body: Awaited<ReturnType<typeof rows>> = await rows({
        select: "id",
        order: "id.asc",
        limit: "2",
        ...(token ? { page_token: token } : {}),
      });
      seen.push(...body.rows.map((r) => r.id));
      token = body.page_token;
      if (!body.truncated) break;
    }
    expect(seen).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    expect(token).toBeNull();
  });

  it("pages correctly through the null bucket", async () => {
    // The keyset predicate has to know which end the nulls are at, or the page
    // after the null row is empty and the walk stops early.
    const first = await rows({ select: "id", order: "due.asc.nullsfirst", limit: "2" });
    expect(first.rows.map((r) => r.id)).toEqual(["c3", "c1"]);
    expect(first.truncated).toBe(true);
    const second = await rows({
      select: "id",
      order: "due.asc.nullsfirst",
      limit: "2",
      page_token: first.page_token!,
    });
    expect(second.rows.map((r) => r.id)).toEqual(["c4", "c2"]);
  });

  it("refuses a token cut under a different ordering rather than restarting", async () => {
    const first = await rows({ select: "id", order: "id.asc", limit: "2" });
    const error = await rejected({
      select: "id",
      order: "id.desc",
      limit: "2",
      page_token: first.page_token!,
    });
    expect(error).toMatch(/cut under a different ordering/);
  });
});

describe("aggregation", () => {
  it("groups by the select list", async () => {
    const body = await groups({
      where: JSON.stringify({ suspended: 0 }),
      select: "deck_id",
      aggregate: JSON.stringify({
        due_count: { fn: "count" },
        next_due: { fn: "min", col: "due" },
        total_reps: { fn: "sum", col: "reps" },
      }),
      order: "deck_id.asc",
    });
    expect(body.groups).toEqual([
      { deck_id: "d1", due_count: 2, next_due: "2026-09-01T00:00:00.000Z", total_reps: 4 },
      { deck_id: "d2", due_count: 2, next_due: "2026-09-03T00:00:00.000Z", total_reps: 9 },
    ]);
  });

  it("counts rows and values differently on a nullable column", async () => {
    const body = await groups({
      aggregate: JSON.stringify({
        rows: { fn: "count" },
        with_due: { fn: "count", col: "due" },
        decks: { fn: "count", distinct: "deck_id" },
      }),
    });
    expect(body.groups).toEqual([{ rows: 5, with_due: 4, decks: 2 }]);
  });

  it("returns null for sum over zero rows rather than coalescing to 0", async () => {
    // A coalesced result cannot distinguish an empty match from a zero total,
    // so the server does not coalesce and the app-facing docs say so.
    const body = await groups({
      where: JSON.stringify({ deck_id: "nonexistent" }),
      aggregate: JSON.stringify({ total: { fn: "sum", col: "reps" } }),
    });
    expect(body.groups).toEqual([{ total: null }]);
  });

  it("omits empty groups entirely", async () => {
    // d1 has a suspended card and d2 has none, so grouping suspended cards by
    // deck produces one row rather than two — a deck with nothing matching
    // produces no row at all rather than a row holding zero, and the client
    // fills the gap from its own list. Worth stating in the app-facing docs,
    // because the alternative reading is a silent hole in a dashboard.
    const body = await groups({
      where: JSON.stringify({ suspended: 1 }),
      select: "deck_id",
      aggregate: JSON.stringify({ n: { fn: "count" } }),
    });
    expect(body.groups).toEqual([{ deck_id: "d1", n: 1 }]);
  });
});

describe("the write path enforces the declared types", () => {
  // A declared type is only worth having if something enforces it, and the
  // write path is the only place it can be: once a value is in the table, the
  // grammar's promise that `due < $x` compares instants rather than characters
  // depends on every writer having emitted the canonical form.
  it("refuses a timestamp that is not canonical ISO-8601", async () => {
    const res = await app.fetch("/app-data/db/card_state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ row: { id: "bad", due: "2026-09-09T00:00:00Z" } }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/canonical ISO-8601/);
  });

  it("refuses a value whose type does not match its column", async () => {
    const res = await app.fetch("/app-data/db/card_state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ row: { id: "bad2", reps: "many" } }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/declared integer/);
  });

  it("accepts what an app that already writes toISOString() sends", async () => {
    const res = await app.fetch("/app-data/db/card_state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        row: { id: "good", deck_id: "d1", due: new Date().toISOString(), reps: 0 },
      }),
    });
    expect(res.status).toBe(200);
  });
});

describe("rejections a caller has to be able to act on", () => {
  it("refuses the flat parameter form the old grammar accepted", async () => {
    // The old handler read every query parameter as an equality filter, so
    // ignoring an unrecognized one would answer the whole table to a caller
    // that asked for one deck.
    const res = await app.fetch("/app-data/db/card_state?deck_id=d1");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/is not a query parameter/);
  });

  it("refuses a value that does not match its column's declared type", async () => {
    expect(await rejected({ where: JSON.stringify({ reps: "3" }) })).toMatch(/declared integer/);
    expect(await rejected({ where: JSON.stringify({ due: "2026-09-09" }) })).toMatch(
      /canonical ISO-8601/,
    );
  });

  it("refuses a column the table does not declare", async () => {
    expect(await rejected({ where: JSON.stringify({ nope: 1 }) })).toMatch(/not a column/);
  });

  it("refuses a limit above the maximum", async () => {
    expect(await rejected({ limit: "501" })).toMatch(/at most 500/);
  });
});
