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
} from "@tasks/tasks-lib";
import { SqliteDatabaseAdapter } from "@starkeep/storage-sqlite";
import { FsObjectStorageAdapter } from "@starkeep/storage-fs";
import type Anthropic from "@anthropic-ai/sdk";

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

// Enable WAL mode so the sidecar and the Tauri SQL plugin can safely share the
// same SQLite file. WAL mode is sticky (written to the DB file) so it carries
// over to every subsequent connection.
const { Database: BunSqlite } = await import("bun:sqlite");
{
  const db = new BunSqlite(input.dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.close();
}

const dbAdapter = new SqliteDatabaseAdapter({ path: input.dbPath });
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
