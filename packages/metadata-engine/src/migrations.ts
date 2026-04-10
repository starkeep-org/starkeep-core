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

    async applyPendingMigrations(generatorId: string, targetType: string): Promise<number> {
      const generatorMigrations = migrations.get(generatorId);
      if (!generatorMigrations || generatorMigrations.length === 0) {
        return 0;
      }

      let migratedCount = 0;

      const result = await databaseAdapter.queryMetadata(targetType, { generatorId });

      for (const entry of result.entries) {
        let currentVersion = entry.generatorVersion;
        let currentValue = { ...entry.value };
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
          await databaseAdapter.putMetadata(targetType, {
            ...entry,
            generatorVersion: currentVersion,
            value: currentValue,
          });
          migratedCount++;
        }
      }

      return migratedCount;
    },

    getMigrations(generatorId: string): MetadataMigration[] {
      return migrations.get(generatorId) ?? [];
    },
  };
}
