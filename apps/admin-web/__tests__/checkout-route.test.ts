/**
 * GET /api/checkout — the checkout's current commit, which the Dashboard
 * compares with the commit the local data server started from.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { GET } from "../src/routes/checkout";

describe("GET /api/checkout", () => {
  it("answers the commit the checkout holds now", async () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(await (await GET()).json()).toEqual({ commit: head });
  });
});
