import {
  createHLCClock,
  createDataRecord,
  makePrivateType,
  type StarkeepId,
  type DataRecord,
  type MetadataRecord,
} from "@starkeep/core";
async function sha256Hex(data: Uint8Array | Buffer): Promise<string> {
  const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const buf = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
import {
  createGeneratorRegistry,
  createDependencyGraph,
  createMetadataEngine,
} from "@starkeep/metadata-engine";
import { createUnifiedIndex } from "@starkeep/index";
import { createAggregationEngine } from "@starkeep/aggregations";
import { createSyncEngine } from "@starkeep/sync-engine";
import { createAccessControlEngine, createEnforcedDatabaseAdapter } from "@starkeep/access-control";
import { createSharedSpaceApi } from "@starkeep/shared-space-api";
import type { StarkeepSdk, StarkeepSdkOptions } from "./types.js";

export async function createStarkeepSdk(
  options: StarkeepSdkOptions,
): Promise<StarkeepSdk> {
  const {
    databaseAdapter: rawDatabaseAdapter,
    objectStorageAdapter,
    ownerId,
    nodeId,
    remoteDatabaseAdapter,
    remoteObjectStorageAdapter,
    generators = [],
    subject,
  } = options;

  const clock =
    options.clock ?? createHLCClock({ nodeId, wallClockFunction: Date.now });

  await rawDatabaseAdapter.init();
  await objectStorageAdapter.init();

  // When a subject is provided, wrap the adapter so every operation is
  // gated by access control and the private-storage structural rule.
  const accessControlEngine = createAccessControlEngine({
    databaseAdapter: rawDatabaseAdapter,
    clock,
    ownerId,
  });
  await accessControlEngine.loadPolicies();

  const databaseAdapter = subject
    ? createEnforcedDatabaseAdapter({
        databaseAdapter: rawDatabaseAdapter,
        accessControlEngine,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
      })
    : rawDatabaseAdapter;

  const generatorRegistry = createGeneratorRegistry();
  const dependencyGraph = createDependencyGraph();

  for (const generator of generators) {
    generatorRegistry.register(generator);
    dependencyGraph.addGenerator(generator);
    // Ensure the per-type metadata table exists for each input type.
    for (const inputType of generator.inputTypes) {
      await databaseAdapter.ensureMetadataTable(
        inputType,
        generator.generatorId,
        generator.outputColumns,
      );
    }
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

  const sharedSpaceApi = createSharedSpaceApi({
    databaseAdapter,
    objectStorageAdapter,
    clock,
    ownerId,
    changeNotifier: syncEngine?.changeNotifier,
  });

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
        const contentHash = await sha256Hex(file);
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
        return databaseAdapter.get(recordId);
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

      async query(params) {
        const result = await databaseAdapter.query(params);
        return result.records;
      },
    },

    metadata: {
      async generate(generatorId, targetId) {
        const record = await databaseAdapter.get(targetId);
        if (!record) {
          throw new Error(`Target record not found: ${targetId}`);
        }
        return metadataEngine.generate({
          generatorId,
          targetId,
          targetType: record.type,
          mode: "on-demand",
        });
      },

      async generateAll(targetId, dataType) {
        return metadataEngine.generateAll(targetId, dataType);
      },

      async getForRecord(targetId) {
        const record = await databaseAdapter.get(targetId);
        if (!record) return [];
        const result = await databaseAdapter.queryMetadata(record.type, { targetId });
        return result.entries;
      },

      async putDirect(targetId, targetType, generatorId, value) {
        return metadataEngine.writeDirect(targetId, targetType, generatorId, value);
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
        if (subject) {
          throw new Error(
            "createPolicy is not available on an app-scoped SDK. Policies are managed by the admin layer.",
          );
        }
        return accessControlEngine.createPolicy(input);
      },

      async revokePolicy(policyId) {
        if (subject) {
          throw new Error(
            "revokePolicy is not available on an app-scoped SDK. Policies are managed by the admin layer.",
          );
        }
        return accessControlEngine.revokePolicy(policyId);
      },

      async listPolicies(listOptions) {
        return accessControlEngine.listPolicies(listOptions);
      },

      async checkAccess(request) {
        return accessControlEngine.checkAccess(request);
      },
    },

    privateStore:
      subject?.subjectType === "app"
        ? (() => {
            return {
              async put(subtype: string, content: Record<string, unknown> = {}) {
                const privateType = makePrivateType(subject.subjectId, subtype);
                const record = createDataRecord({ type: privateType, ownerId, content }, clock);
                await databaseAdapter.put(record);
                return record;
              },

              async get(recordId: StarkeepId) {
                return databaseAdapter.get(recordId);
              },

              async delete(recordId: StarkeepId) {
                await databaseAdapter.delete(recordId);
              },
            };
          })()
        : null,

    api: {
      get router() {
        return sharedSpaceApi.router;
      },
      async handleRequest(request) {
        return sharedSpaceApi.handleRequest(request);
      },
      handleWebSocketConnect(connection) {
        return sharedSpaceApi.handleWebSocketConnect(connection);
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
