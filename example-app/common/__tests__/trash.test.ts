import { describe, expect, it } from "vitest";
import { trashFile } from "../src/trash.js";

describe("trashFile", () => {
  it("sends one record delete, with the id encoded, and nothing else", async () => {
    const calls: [string, string][] = [];
    const ids = await trashFile(async (method, path) => {
      calls.push([method, path]);
      return { ids: ["REC 1", "COPY1"] };
    }, "REC 1");
    expect(calls).toEqual([["DELETE", "/data/records/REC%201"]]);
    expect(ids).toEqual(["REC 1", "COPY1"]);
  });
});
