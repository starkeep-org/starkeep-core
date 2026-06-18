import { describe, expect, it } from "vitest";
import {
  loadAccessGrants,
  canRead,
  canWrite,
  canReadCategory,
  canWriteCategory,
  USER_DATA_OWNER_APP_ID,
} from "../src/access-enforcer.js";
import type { DatabaseClient } from "@starkeep/storage-aurora-dsql";

/** A DatabaseClient whose query() returns scripted rows (or throws if none scripted). */
function scriptedClient(rows?: Array<{ type_id: string; access: string }>): DatabaseClient {
  return {
    async query() {
      if (!rows) throw new Error("query() should not have been called");
      return { rows };
    },
    async end() {},
  };
}

describe("loadAccessGrants", () => {
  it("grants Drive all-access by app id without querying", async () => {
    const grants = await loadAccessGrants(scriptedClient(), USER_DATA_OWNER_APP_ID);
    expect(grants.allAccess).toBe(true);
    expect(grants.readableTypes.size).toBe(0);
    expect(grants.writableTypes.size).toBe(0);
  });

  it("maps read rows to readableTypes only and readwrite rows to both", async () => {
    const grants = await loadAccessGrants(
      scriptedClient([
        { type_id: "document/pdf", access: "read" },
        { type_id: "image/jpeg", access: "readwrite" },
      ]),
      "photos",
    );
    expect(grants.allAccess).toBe(false);
    expect([...grants.readableTypes].sort()).toEqual(["document/pdf", "image/jpeg"]);
    expect([...grants.writableTypes]).toEqual(["image/jpeg"]);
  });

  it("derives categories from type grants via typeCategory", async () => {
    const grants = await loadAccessGrants(
      scriptedClient([
        { type_id: "image/jpeg", access: "readwrite" },
        { type_id: "image/png", access: "readwrite" },
        { type_id: "video/mp4", access: "read" },
      ]),
      "photos",
    );
    expect([...grants.readableCategories].sort()).toEqual(["image", "video"]);
    expect([...grants.writableCategories]).toEqual(["image"]);
  });

  it("returns empty grants for an app with no rows", async () => {
    const grants = await loadAccessGrants(scriptedClient([]), "nothing-granted");
    expect(grants.allAccess).toBe(false);
    expect(grants.readableTypes.size).toBe(0);
    expect(grants.writableTypes.size).toBe(0);
    expect(grants.readableCategories.size).toBe(0);
    expect(grants.writableCategories.size).toBe(0);
  });

  it("ignores unknown access values", async () => {
    const grants = await loadAccessGrants(
      scriptedClient([{ type_id: "image/jpeg", access: "admin" }]),
      "photos",
    );
    expect(grants.readableTypes.size).toBe(0);
    expect(grants.writableTypes.size).toBe(0);
  });
});

describe("canRead / canWrite / canReadCategory / canWriteCategory", () => {
  it("gate on the loaded type and category sets", async () => {
    const grants = await loadAccessGrants(
      scriptedClient([
        { type_id: "image/jpeg", access: "readwrite" },
        { type_id: "document/pdf", access: "read" },
      ]),
      "photos",
    );
    expect(canRead(grants, "image/jpeg")).toBe(true);
    expect(canWrite(grants, "image/jpeg")).toBe(true);
    expect(canRead(grants, "document/pdf")).toBe(true);
    expect(canWrite(grants, "document/pdf")).toBe(false);
    expect(canRead(grants, "audio/mp3")).toBe(false);
    expect(canReadCategory(grants, "image")).toBe(true);
    expect(canWriteCategory(grants, "image")).toBe(true);
    expect(canReadCategory(grants, "document")).toBe(true);
    expect(canWriteCategory(grants, "document")).toBe(false);
    expect(canReadCategory(grants, "audio")).toBe(false);
  });

  it("all-access passes every type and category, including other", async () => {
    const grants = await loadAccessGrants(scriptedClient(), USER_DATA_OWNER_APP_ID);
    expect(canRead(grants, "anything-at-all")).toBe(true);
    expect(canWrite(grants, "anything-at-all")).toBe(true);
    expect(canReadCategory(grants, "other")).toBe(true);
    expect(canWriteCategory(grants, "other")).toBe(true);
  });
});
