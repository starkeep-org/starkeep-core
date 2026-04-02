/**
 * Bun sidecar entry point for the Starkeep Tasks AI agent.
 *
 * Invoked by the Tauri Rust backend with a single JSON argument:
 *   bun run sidecar/index.ts '<SidecarInput JSON>'
 * (or as a compiled binary: agent-sidecar-<target-triple> '<SidecarInput JSON>')
 *
 * Emits AgentEvent JSON lines to stdout. The Rust backend reads them and
 * re-emits them as Tauri events to the webview.
 */

import { createStarkeepSdk } from "@starkeep/sdk";
import {
  bootstrapTasksAppPolicies,
  runAgenticLoop,
  taskPropertiesGenerator,
  taskHistoryGenerator,
  registerTasksEndpoints,
  TASKS_APP_ID,
  GROUP_RECORD_TYPE,
  GROUP_MIME_TYPE,
  groupObjectStorageKey,
  encodeTdgFile,
  ORDERING_RECORD_TYPE,
  getOrderingPayload,
} from "@tasks/tasks-lib";
import { BunSqliteDatabaseAdapter } from "./bun-sqlite-adapter.ts";
import { FsObjectStorageAdapter } from "@starkeep/storage-fs";
import type Anthropic from "@anthropic-ai/sdk";
import type { DataRecord } from "@starkeep/core";

interface SidecarInput {
  sessionId: string;
  messages: Anthropic.MessageParam[];
  userId: string;
  groupId: string;
  /** Absolute path to the SQLite DB file (e.g. .../AppLocalData/tasks.db) */
  dbPath: string;
  /** Absolute path to the objects directory (e.g. .../AppLocalData/objects) */
  objectsPath: string;
  anthropicApiKey: string;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * One-time idempotent migration: for each tasks:group record that has no
 * objectStorageKey, find its corresponding tasks:ordering record, build a
 * TdgFileContent, write the .tdg file, and update the group DataRecord.
 *
 * Safe to run on every startup — records with objectStorageKey are skipped.
 */
async function migrateLegacyGroupFiles(
  databaseAdapter: { query: Function; put: Function },
  objectStorageAdapter: { put: Function },
  ownerId: string,
): Promise<void> {
  const groupResult = await databaseAdapter.query({
    type: GROUP_RECORD_TYPE,
    filters: [{ field: "ownerId", operator: "eq", value: ownerId }],
  });

  for (const record of groupResult.records) {
    const dataRecord = record as DataRecord;
    if (dataRecord.objectStorageKey) continue; // already migrated

    const payload = dataRecord.payload as { name?: string; description?: string; ownerId?: string };

    // Find the corresponding ordering record
    let orderedTaskIds: string[] = [];
    try {
      const orderingResult = await databaseAdapter.query({
        type: ORDERING_RECORD_TYPE,
        filters: [{ field: "payload.groupId", operator: "eq", value: dataRecord.id }],
        limit: 1,
      });
      if (orderingResult.records.length > 0) {
        orderedTaskIds = getOrderingPayload(orderingResult.records[0] as DataRecord).orderedTaskIds;
      }
    } catch {
      // No ordering record found — start with empty list
    }

    const fileContent = {
      name: payload.name ?? "",
      description: payload.description ?? "",
      ownerId: payload.ownerId ?? ownerId,
      orderedTaskIds,
    };

    const fileBytes = encodeTdgFile(fileContent);
    const contentHash = await sha256Hex(fileBytes);
    const key = groupObjectStorageKey(dataRecord.id);

    await objectStorageAdapter.put(key, fileBytes, { contentType: GROUP_MIME_TYPE });

    const updatedRecord: DataRecord = {
      ...dataRecord,
      objectStorageKey: key,
      contentHash,
      sizeBytes: fileBytes.length,
    };
    await databaseAdapter.put(updatedRecord);
  }
}

function emitEvent(event: object): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

const inputJson = process.argv[2];
if (!inputJson) {
  emitEvent({ type: "error", message: "No input argument provided to sidecar" });
  process.exit(1);
}

let input: SidecarInput;
try {
  input = JSON.parse(inputJson);
} catch (err) {
  emitEvent({ type: "error", message: `Failed to parse sidecar input: ${err}` });
  process.exit(1);
}

// BunSqliteDatabaseAdapter sets WAL mode on init, so no separate pragma step needed.
const dbAdapter = new BunSqliteDatabaseAdapter({ path: input.dbPath });
const fsAdapter = new FsObjectStorageAdapter({ basePath: input.objectsPath });

const sharedOptions = {
  databaseAdapter: dbAdapter,
  objectStorageAdapter: fsAdapter,
  ownerId: input.userId,
  // Unique node ID per session keeps HLC timestamps conflict-free.
  nodeId: `sidecar-${input.sessionId.slice(0, 8)}`,
};

// Bootstrap access policies with an owner-level SDK, then close it.
const ownerSdk = await createStarkeepSdk({ ...sharedOptions, generators: [] });
await bootstrapTasksAppPolicies(ownerSdk);

// Migrate legacy data: convert tasks:group + tasks:ordering pairs into .tdg files.
await migrateLegacyGroupFiles(dbAdapter, fsAdapter, input.userId);

await ownerSdk.close();

// Re-initialise as the tasks app subject so access control is enforced.
const sdk = await createStarkeepSdk({
  ...sharedOptions,
  generators: [taskPropertiesGenerator, taskHistoryGenerator],
  subject: { subjectType: "app", subjectId: TASKS_APP_ID },
});

registerTasksEndpoints(sdk.api.router);

try {
  for await (const event of runAgenticLoop(input.messages, {
    sdk,
    userId: input.userId,
    groupId: input.groupId,
    apiKey: input.anthropicApiKey,
  })) {
    emitEvent(event);
    if (event.type === "done" || event.type === "error") break;
  }
} catch (err) {
  emitEvent({
    type: "error",
    message: err instanceof Error ? err.message : String(err),
  });
}

await sdk.close();
