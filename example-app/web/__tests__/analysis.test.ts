/**
 * Notes store UTC timestamps. The analysis route must count each note on the
 * day the user saw, not on the UTC day.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { TABLES } from "@example-app/common";
import { NOTES_BY_DAY, notesByDay } from "../src/server/analysis.js";

function days(offset: string): unknown[] {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE ${TABLES.notes} (record_id TEXT, note TEXT, pinned INTEGER, updated_on TEXT)`,
  );
  // 01:00 UTC on the 16th is 20:00 on the 15th in New York (UTC-5).
  db.prepare(
    `INSERT INTO ${TABLES.notes} VALUES ('A', 'late', 0, '2026-11-16T01:00:00.000Z')`,
  ).run();
  db.prepare(`INSERT INTO ${TABLES.notes} VALUES ('B', 'undated', 0, NULL)`).run();
  return db
    .prepare(NOTES_BY_DAY)
    .all(offset)
    .map((row) => row["day"]);
}

describe("NOTES_BY_DAY", () => {
  it("buckets a UTC timestamp by the caller's day", () => {
    expect(days("-300 minutes")).toEqual(["2026-11-15", null]);
    expect(days("0 minutes")).toEqual(["2026-11-16", null]);
  });
});

describe("notesByDay", () => {
  it.each(["abc", "1.5", "900"])("refuses utcOffset=%s", async (utcOffset) => {
    const res = await notesByDay(
      new Request(`http://localhost/api/notes-by-day?utcOffset=${utcOffset}`),
    );
    expect(res.status).toBe(400);
  });
});
