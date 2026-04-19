/**
 * Starkeep cloud-side HTTP server.
 *
 * Phase 1: runs locally on a different port from the data-server, backed by
 * local Postgres via the existing AuroraDsqlDatabaseAdapter and a local-FS
 * object store. This validates the sync protocol on the production adapter
 * code path without paying the Aurora DSQL provisioning cost.
 */

import { createServer } from "node:http";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHLCClock } from "@starkeep/core";
import { AuroraDsqlDatabaseAdapter } from "@starkeep/storage-aurora-dsql";
import { FsObjectStorageAdapter } from "@starkeep/storage-fs";
import { createHttpSyncHandler } from "@starkeep/sync-engine";
import { createPgClientFactory } from "./pg-client-factory.js";

const PG_URL =
  process.env.CLOUD_PG_URL ??
  "postgres://postgres@127.0.0.1:5434/starkeep_cloud";
const OBJECT_DIR =
  process.env.CLOUD_OBJECT_DIR ?? join(homedir(), ".starkeep-cloud", "objects");
const PORT = parseInt(process.env.CLOUD_PORT ?? "9920", 10);
const NODE_ID = process.env.CLOUD_NODE_ID ?? "cloud";

async function main() {
  const databaseAdapter = new AuroraDsqlDatabaseAdapter(
    { hostname: "local", region: "local", database: "starkeep_cloud" },
    createPgClientFactory(PG_URL),
  );
  await databaseAdapter.init();

  const objectStorageAdapter = new FsObjectStorageAdapter({ basePath: OBJECT_DIR });
  await objectStorageAdapter.init();

  const clock = createHLCClock({ nodeId: NODE_ID });

  const syncHandler = createHttpSyncHandler({
    databaseAdapter,
    objectStorageAdapter,
    clock,
  });

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", node: NODE_ID }));
        return;
      }

      const handled = await syncHandler(req, res);
      if (!handled) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      }
    } catch (err) {
      console.error("Request error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : "Internal error",
        }),
      );
    }
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Starkeep cloud-server listening on http://127.0.0.1:${PORT}`);
    console.log(`  pg: ${PG_URL}`);
    console.log(`  objects: ${OBJECT_DIR}`);
    console.log(`  node: ${NODE_ID}`);
  });

  const shutdown = async () => {
    console.log("Shutting down...");
    server.close();
    await databaseAdapter.close();
    await objectStorageAdapter.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Failed to start cloud-server:", err);
  process.exit(1);
});
