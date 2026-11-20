/** `deleteAppDataOp`: it deletes only with the app id typed back, and previews otherwise. */
import { describe, expect, it } from "vitest";
import { AppStillInstalledError } from "../../src/cloud-app-data.js";
import { deleteAppDataOp } from "../../src/operations/delete-app-data.js";
import type { AppDataCountsDsql } from "../../src/dsql-ddl.js";
import { INSTALLED_CONFIG, starkeepDirWith, testContext, withCode } from "./helpers.js";

const COUNTS = {
  retained: { appId: "example-app", name: "Example" },
  tables: [{ name: "notes", rowCount: 3 }],
  totalRows: 3,
  files: { count: 2, totalBytes: 10 },
} as unknown as AppDataCountsDsql;

function setup(
  behavior: "delete" | "installed" = "delete",
  hooks: { confirmDeletion?: () => Promise<boolean> } = {},
) {
  const outcomes: string[] = [];
  const t = testContext(starkeepDirWith(INSTALLED_CONFIG), {
    createDsqlRegistry: (() => ({ close: async () => {} })) as never,
    deleteAppDataCloud: async (input) => {
      if (behavior === "installed") throw new AppStillInstalledError(input.appId);
      const ok = await input.confirm(COUNTS);
      outcomes.push(ok ? "deleted" : "cancelled");
      return ok ? "deleted" : "cancelled";
    },
    ...hooks,
  });
  return { t, outcomes };
}

describe("deleteAppDataOp", () => {
  it("deletes when the input types the app id back", async () => {
    const { t, outcomes } = setup();
    const result = await deleteAppDataOp(
      t.ctx,
      { appId: "example-app", confirm: "example-app" },
      t.emit,
    );
    expect(result).toMatchObject({ outcome: "deleted", counts: { totalRows: 3 } });
    expect(outcomes).toEqual(["deleted"]);
    expect(t.progress()).toContain("Deleting it removes 3 rows and the files");
  });

  it("previews the counts and deletes nothing", async () => {
    const { t, outcomes } = setup();
    const result = await deleteAppDataOp(t.ctx, { appId: "example-app", preview: true }, t.emit);
    expect(result).toMatchObject({
      outcome: "previewed",
      counts: { totalRows: 3, files: { count: 2 } },
    });
    expect(outcomes).toEqual(["cancelled"]);
  });

  it("reports NOT_CONFIRMED without the id typed back, and for a wrong id before touching AWS", async () => {
    let { t, outcomes } = setup();
    await expect(deleteAppDataOp(t.ctx, { appId: "example-app" }, t.emit)).rejects.toEqual(
      withCode("NOT_CONFIRMED"),
    );
    expect(outcomes).toEqual(["cancelled"]);
    expect(t.events.some((e) => e.type === "prompt-needed")).toBe(true);
    ({ t, outcomes } = setup());
    await expect(
      deleteAppDataOp(t.ctx, { appId: "example-app", confirm: "photos" }, t.emit),
    ).rejects.toEqual(withCode("NOT_CONFIRMED"));
    expect(t.lanes).toEqual([]);
  });

  it("asks a caller in the same process through confirmDeletion", async () => {
    const { t, outcomes } = setup("delete", { confirmDeletion: async () => true });
    await deleteAppDataOp(t.ctx, { appId: "example-app" }, t.emit);
    expect(outcomes).toEqual(["deleted"]);
  });

  it("reports REFUSED for an app still installed in the cloud", async () => {
    const { t } = setup("installed");
    await expect(
      deleteAppDataOp(t.ctx, { appId: "example-app", confirm: "example-app" }, t.emit),
    ).rejects.toEqual(withCode("REFUSED"));
  });
});
