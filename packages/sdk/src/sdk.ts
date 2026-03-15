import {
  createHLCClock,
  createDataRecord,
  generateId,
  type StarkeepId,
  type DataRecord,
  type MetadataRecord,
} from "@starkeep/core";
import { createHash } from "node:crypto";
import {
  createGeneratorRegistry,
  createDependencyGraph,
  createMetadataEngine,
} from "@starkeep/metadata-engine";
import { createUnifiedIndex } from "@starkeep/index";
import { createAggregationEngine } from "@starkeep/aggregations";
import { createSyncEngine } from "@starkeep/sync-engine";
import { createAccessControlEngine } from "@starkeep/access-control";
import { createSharedSpaceApi } from "@starkeep/shared-space-api";
import type { StarkeepSdk, StarkeepSdkOptions } from "./types.js";

export async function createStarkeepSdk(
  options: StarkeepSdkOptions,
): Promise<StarkeepSdk> {
  const {
    databaseAdapter,
    objectStorageAdapter,
    ownerId,
    nodeId,
    remoteDatabaseAdapter,
    remoteObjectStorageAdapter,
    generators = [],
  } = options;

  const clock =
    options.clock ?? createHLCClock({ nodeId, wallClockFunction: Date.now });

  await databaseAdapter.init();
  await objectStorageAdapter.init();

  const generatorRegistry = createGeneratorRegistry();
  const dependencyGraph = createDependencyGraph();

  for (const generator of generators) {
    generatorRegistry.register(generator);
    dependencyGraph.addGenerator(generator);
  }

  const metadataEngine = createMetadataEngine({
    databaseAdapter,
    objectStorageAdapter,
    clock,
    ownerId,
    generatorRegistry,
    dependencyGraph,
  });

  const unifiedIndex = createUnifiedIndex({ databaseAdapter });
  const aggregationEngine = createAggregationEngine({ databaseAdapter });
  const accessControlEngine = createAccessControlEngine({
    databaseAdapter,
    clock,
    ownerId,
  });

  const sharedSpaceApi = createSharedSpaceApi({
    databaseAdapter,
    objectStorageAdapter,
    clock,
    ownerId,
  });

  let syncEngine = null;
  if (remoteDatabaseAdapter && remoteObjectStorageAdapter) {
    await remoteDatabaseAdapter.init();
    await remoteObjectStorageAdapter.init();

    syncEngine = createSyncEngine({
      localDatabaseAdapter: databaseAdapter,
      remoteDatabaseAdapter,
      localObjectStorage: objectStorageAdapter,
      remoteObjectStorage: remoteObjectStorageAdapter,
      clock,
    });
  }

  return {
    data: {
      async put(input) {
        const record = createDataRecord(input, clock);
        await databaseAdapter.put(record);
        if (syncEngine) {
          await syncEngine.recordChange("create", record);
        }
        return record;
      },

      async putWithFile(input, file, contentType) {
        const contentHash = createHash("sha256")
          .update(file)
          .digest("hex");
        const objectStorageKey = `${contentHash.slice(0, 2)}/${contentHash}`;

        await objectStorageAdapter.put(objectStorageKey, file, {
          contentType,
        });

        const record = createDataRecord(
          {
            ...input,
            contentHash,
            objectStorageKey,
            mimeType: contentType ?? null,
            sizeBytes: file.length,
          },
          clock,
        );
        await databaseAdapter.put(record);
        if (syncEngine) {
          await syncEngine.recordChange("create", record);
        }
        return record;
      },

      async get(recordId) {
        const record = await databaseAdapter.get(recordId);
        if (!record || record.kind !== "data") return null;
        return record as DataRecord;
      },

      async delete(recordId) {
        await databaseAdapter.delete(recordId);
        if (syncEngine) {
          const record = await databaseAdapter.get(recordId);
          if (record) {
            await syncEngine.recordChange("delete", record);
          }
        }
      },
    },

    metadata: {
      async generate(generatorId, targetId) {
        return metadataEngine.generate({
          generatorId,
          targetId,
          mode: "on-demand",
        });
      },

      async generateAll(targetId, dataType) {
        return metadataEngine.generateAll(targetId, dataType);
      },

      async getForRecord(targetId) {
        const result = await databaseAdapter.query({
          kind: "metadata",
          filters: [
            { field: "targetId", operator: "eq", value: targetId },
          ],
        });
        return result.records as MetadataRecord[];
      },
    },

    index: {
      async search(query) {
        return unifiedIndex.search(query);
      },
    },

    aggregations: {
      async compute(aggregationOptions) {
        return aggregationEngine.compute(aggregationOptions);
      },
    },

    sync: syncEngine
      ? {
          async push() {
            const result = await syncEngine!.push();
            return {
              pushed: result.accepted.length,
              conflicts: result.conflicts.length,
            };
          },

          async pull() {
            const result = await syncEngine!.pull();
            return { pulled: result.changes.length };
          },

          async fullSync() {
            return syncEngine!.fullSync();
          },

          onUpdate(listener) {
            return syncEngine!.changeNotifier.subscribe(listener);
          },
        }
      : null,

    accessControl: {
      async createPolicy(input) {
        return accessControlEngine.createPolicy(input);
      },

      async revokePolicy(policyId) {
        return accessControlEngine.revokePolicy(policyId);
      },

      async listPolicies(listOptions) {
        return accessControlEngine.listPolicies(listOptions);
      },

      async checkAccess(request) {
        return accessControlEngine.checkAccess(request);
      },
    },

    api: {
      async handleRequest(request) {
        return sharedSpaceApi.handleRequest(request);
      },
    },

    async close() {
      await databaseAdapter.close();
      await objectStorageAdapter.close();
      if (remoteDatabaseAdapter) {
        await remoteDatabaseAdapter.close();
      }
      if (remoteObjectStorageAdapter) {
        await remoteObjectStorageAdapter.close();
      }
    },
  };
}
