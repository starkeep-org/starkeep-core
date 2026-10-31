import { describe, it, expect } from "vitest";
import { guardSingleFlight } from "../src/single-flight.js";
import type { DatabaseClient } from "../src/types.js";

/** A client whose queries settle only when the test releases them. */
function slowClient() {
  const ran: string[] = [];
  const pending: Array<() => void> = [];
  const client: DatabaseClient = {
    query(text) {
      ran.push(text);
      return new Promise((resolve) => pending.push(() => resolve({ rows: [] })));
    },
    async end() {},
  };
  const releaseAll = () => {
    for (const release of pending.splice(0)) release();
  };
  return { client, ran, releaseAll };
}

describe("guardSingleFlight", () => {
  it("lets strictly sequential statements through", async () => {
    const { client, ran, releaseAll } = slowClient();
    const guarded = guardSingleFlight(client, { onOverlap: "throw" });
    const first = guarded.query("SELECT 1");
    releaseAll();
    await first;
    const second = guarded.query("SELECT 2");
    releaseAll();
    await second;
    expect(ran).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("refuses an overlapping statement in throw mode, without sending it", async () => {
    const { client, ran, releaseAll } = slowClient();
    const guarded = guardSingleFlight(client, { onOverlap: "throw" });
    const first = guarded.query("SELECT 1");
    await expect(guarded.query("SELECT 2")).rejects.toThrow(/refused a statement started while/);
    releaseAll();
    await first;
    expect(ran).toEqual(["SELECT 1"]);
  });

  it("warns with the stack once per call site in warn mode, and still sends the statement", async () => {
    const { client, ran, releaseAll } = slowClient();
    const warnings: string[] = [];
    const guarded = guardSingleFlight(client, {
      onOverlap: "warn",
      warn: (message) => warnings.push(message),
    });
    const overlapFromOneSite = () => guarded.query("SELECT n");
    const first = guarded.query("SELECT 1");
    const overlaps = Array.from({ length: 2 }, () => overlapFromOneSite());
    releaseAll();
    await Promise.all([first, ...overlaps]);
    expect(ran).toEqual(["SELECT 1", "SELECT n", "SELECT n"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^\[pg-overlap\] .*SELECT n/);
    expect(warnings[0]).toContain("overlapFromOneSite");
  });

  it("clears the in-flight state when a statement fails", async () => {
    const failing: DatabaseClient = {
      query: async () => {
        throw new Error("boom");
      },
      async end() {},
    };
    const guarded = guardSingleFlight(failing, { onOverlap: "throw" });
    await expect(guarded.query("SELECT 1")).rejects.toThrow("boom");
    await expect(guarded.query("SELECT 2")).rejects.toThrow("boom");
  });
});
