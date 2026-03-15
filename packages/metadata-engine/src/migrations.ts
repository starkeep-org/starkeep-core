import type { StarkeepId, MetadataRecord } from "@starkeep/core";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";
import type { MigrationRunner, MetadataMigration } from "./types.js";

export function createMigrationRunner(
  databaseAdapter: DatabaseAdapter,
): MigrationRunner {
  const migrations = new Map<string, MetadataMigration[]>();

  return {
    registerMigration(migration: MetadataMigration): void {
      const existing = migrations.get(migration.generatorId) ?? [];
      existing.push(migration);
      existing.sort((a, b) => a.fromVersion - b.fromVersion);
      migrations.set(migration.generatorId, existing);
    },

    async applyPendingMigrations(generatorId: string): Promise<number> {
      const generatorMigrations = migrations.get(generatorId);
      if (!generatorMigrations || generatorMigrations.length === 0) {
        return 0;
      }

      let migratedCount = 0;
      let cursor: string | undefined;

      while (true) {
        const result = await databaseAdapter.query({
          kind: "metadata",
          filters: [
            { field: "generatorId", operator: "eq", value: generatorId },
          ],
          limit: 100,
          cursor,
        });

        for (const record of result.records) {
          const metadataRecord = record as MetadataRecord;
          let currentVersion = metadataRecord.generatorVersion;
          let currentValue = { ...metadataRecord.value };
          let wasMigrated = false;

          for (const migration of generatorMigrations) {
            if (
              migration.fromVersion === currentVersion &&
              migration.toVersion > currentVersion
            ) {
              currentValue = migration.migrate(currentValue);
              currentVersion = migration.toVersion;
              wasMigrated = true;
            }
          }

          if (wasMigrated) {
            const updated: MetadataRecord = {
              ...metadataRecord,
              generatorVersion: currentVersion,
              value: currentValue,
              version: metadataRecord.version + 1,
            };
            await databaseAdapter.put(updated);
            migratedCount++;
          }
        }

        if (!result.hasMore) break;
        cursor = result.nextCursor ?? undefined;
      }

      return migratedCount;
    },

    getMigrations(generatorId: string): MetadataMigration[] {
      return migrations.get(generatorId) ?? [];
    },
  };
}
