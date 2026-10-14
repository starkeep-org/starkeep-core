/**
 * KNOWN FAILING — a durable record of findings problem 8, deferred on
 * 2026-10-14 to a later round (`plan-sync-latency-fixes-2026-10-14.md`,
 * "Decisions needed", decision 2).
 *
 * A local uninstall deletes an app's registry row, secret included, and the
 * next local install mints a new secret. Only a cloud install copies the local
 * secret to SSM, so a local reinstall of a cloud-installed app leaves the cloud
 * verifying with the old secret, and every exchange on that app's channel is
 * rejected. Photos' channel failed this way from 2026-10-08 until repaired.
 *
 * Written against the recommended fix, keeping the secret across a local
 * uninstall. If the round chooses re-mirroring on local install instead, this
 * test is replaced, not deleted.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initializeLocalSchema } from "@starkeep/storage-sqlite";
import { installLocal, uninstallLocal } from "../src/local/installer.js";

const MANIFEST = {
  id: "drift-app",
  name: "Drift",
  version: "1.0.0",
  tier: "community",
  infraRequirements: {},
};

describe("an app's HMAC secret across a local reinstall", () => {
  it("is the same secret after uninstall and install, so the cloud's copy still matches", () => {
    const db = new DatabaseSync(":memory:") as never;
    initializeLocalSchema(db);
    const first = installLocal(db, MANIFEST);
    uninstallLocal(db, "drift-app");
    const second = installLocal(db, MANIFEST);
    expect(second.hmacSecret).toBe(first.hmacSecret);
  });
});
