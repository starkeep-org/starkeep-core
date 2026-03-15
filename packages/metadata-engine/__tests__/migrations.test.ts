import { describe, it, expect } from "vitest";
import {
  createHLCClock,
  createMetadataRecord,
  createStarkeepId,
} from "@starkeep/core";
import { MockDatabaseAdapter } from "@starkeep/storage-adapter";
import { createMigrationRunner } from "../src/migrations.js";

describe("createMigrationRunner", () => {
  it("should register and list migrations", () => {
    const databaseAdapter = new MockDatabaseAdapter();
    const runner = createMigrationRunner(databaseAdapter);

    runner.registerMigration({
      generatorId: "@test:dims",
      fromVersion: 1,
      toVersion: 2,
      migrate: (value) => ({ ...value, format: "v2" }),
    });

    const migrations = runner.getMigrations("@test:dims");
    expect(migrations).toHaveLength(1);
  });

  it("should return empty array for unknown generator", () => {
    const databaseAdapter = new MockDatabaseAdapter();
    const runner = createMigrationRunner(databaseAdapter);

    expect(runner.getMigrations("@test:unknown")).toEqual([]);
  });

  it("should apply pending migrations to metadata records", async () => {
    const databaseAdapter = new MockDatabaseAdapter();
    await databaseAdapter.init();

    const clock = createHLCClock({
      nodeId: "test",
      wallClockFunction: () => 1000,
    });
    const targetId = createStarkeepId("01ARZ3NDEKTSV4RRFFQ69G5FAV");

    const record = createMetadataRecord(
      {
        type: "@test:dims",
        ownerId: "u1",
        targetId,
        generatorId: "@test:dims",
        generatorVersion: 1,
        inputHash: "hash1",
        value: { width: 100, height: 200 },
      },
      clock,
    );
    await databaseAdapter.put(record);

    const runner = createMigrationRunner(databaseAdapter);
    runner.registerMigration({
      generatorId: "@test:dims",
      fromVersion: 1,
      toVersion: 2,
      migrate: (value) => ({
        ...value,
        aspectRatio: (value.width as number) / (value.height as number),
      }),
    });

    const migratedCount = await runner.applyPendingMigrations("@test:dims");
    expect(migratedCount).toBe(1);

    const updated = await databaseAdapter.get(record.id);
    expect(updated).toBeDefined();
    expect(updated!.kind).toBe("metadata");
    if (updated!.kind === "metadata") {
      expect(updated!.generatorVersion).toBe(2);
      expect(updated!.value).toEqual({
        width: 100,
        height: 200,
        aspectRatio: 0.5,
      });
    }
  });

  it("should apply chained migrations", async () => {
    const databaseAdapter = new MockDatabaseAdapter();
    await databaseAdapter.init();

    const clock = createHLCClock({
      nodeId: "test",
      wallClockFunction: () => 1000,
    });
    const targetId = createStarkeepId("01ARZ3NDEKTSV4RRFFQ69G5FAV");

    const record = createMetadataRecord(
      {
        type: "@test:dims",
        ownerId: "u1",
        targetId,
        generatorId: "@test:dims",
        generatorVersion: 1,
        inputHash: "hash1",
        value: { w: 100, h: 200 },
      },
      clock,
    );
    await databaseAdapter.put(record);

    const runner = createMigrationRunner(databaseAdapter);
    runner.registerMigration({
      generatorId: "@test:dims",
      fromVersion: 1,
      toVersion: 2,
      migrate: (value) => ({
        width: value.w,
        height: value.h,
      }),
    });
    runner.registerMigration({
      generatorId: "@test:dims",
      fromVersion: 2,
      toVersion: 3,
      migrate: (value) => ({
        ...value,
        megapixels:
          ((value.width as number) * (value.height as number)) / 1_000_000,
      }),
    });

    const migratedCount = await runner.applyPendingMigrations("@test:dims");
    expect(migratedCount).toBe(1);

    const updated = await databaseAdapter.get(record.id);
    if (updated!.kind === "metadata") {
      expect(updated!.generatorVersion).toBe(3);
      expect(updated!.value).toEqual({
        width: 100,
        height: 200,
        megapixels: 0.02,
      });
    }
  });

  it("should return 0 when no migrations needed", async () => {
    const databaseAdapter = new MockDatabaseAdapter();
    await databaseAdapter.init();
    const runner = createMigrationRunner(databaseAdapter);

    const count = await runner.applyPendingMigrations("@test:dims");
    expect(count).toBe(0);
  });
});
