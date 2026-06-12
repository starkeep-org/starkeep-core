/**
 * Fake cloud responder for Tier-1 sync tests.
 *
 * Stands in for the real cloud-data-server: real exchange semantics (the same
 * in-process transport the engine test-suite trusts, over real SQLite + FS
 * storage) behind the same per-app HTTP surface the local-data-server's
 * supervisor talks to — `POST /apps/{appId}/sync/exchange` plus the
 * presign/file endpoints `HttpObjectStorageAdapter` expects. Auth is accepted
 * unconditionally; HMAC correctness is covered by the app-client/server
 * contract tests, not here.
 *
 * Channel split mirrors production:
 *   - `/apps/starkeep-drive/*` — shared records only (syncSharedRecords=true).
 *   - `/apps/<other>/*`        — that app's app-specific rows only.
 *
 * App-specific rows only apply if the app is "cloud-installed" first via
 * `installApp()` (which reuses the real installer against the cloud-side DB,
 * the honest analogue of the DSQL DDL step).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createHLCClock, type AnyRecord } from "@starkeep/protocol-primitives";
import {
  SqliteDatabaseAdapter,
  SqliteAppSyncableNamespaceStore,
  SqliteAppSyncableApplier,
  appSyncableTableName,
} from "@starkeep/storage-sqlite";
import { FsObjectStorageAdapter } from "@starkeep/storage-fs";
import {
  createInProcessSyncTransport,
  type SyncTransport,
  type SyncExchangeRequest,
} from "@starkeep/sync-engine";
import { installLocal, uninstallLocal, type InstallLocalResult } from "@starkeep/admin-installer";
import { getFreePort } from "./local-data-server.js";

export interface FakeCloudExchangeLogEntry {
  readonly appId: string;
  readonly at: number;
  /** Counts from the requester's payload (what the local side shipped up). */
  readonly inRecords: number;
  readonly inAppRows: number;
  /** Counts from the response (what the cloud shipped down). */
  readonly outRecords: number;
  readonly outAppRows: number;
}

export interface FakeCloudFailures {
  /** Fail this many upcoming /sync/exchange calls with a 500, then recover. */
  exchanges: number;
  /** While true, every /sync/exchange call fails with a 500. */
  allExchanges: boolean;
  /** Fail this many upcoming blob-download presigns (GET path) with a 500. */
  blobGets: number;
  /** Fail this many upcoming blob-upload presigns (PUT path) with a 500. */
  blobPuts: number;
}

export interface FakeCloud {
  url: string;
  port: number;
  /** Temp dir holding the cloud-side SQLite DB and blob store. */
  dir: string;
  /** Raw cloud-side DB handle for direct assertions. */
  db: DatabaseSync;
  /**
   * "Cloud-install" an app: registers it and creates its syncable tables in
   * the cloud-side DB so its per-app channel applies incoming rows.
   */
  installApp(manifest: unknown): InstallLocalResult;
  uninstallApp(appId: string): void;
  /** All exchanges served, in order. */
  exchangeLog: FakeCloudExchangeLogEntry[];
  clearExchangeLog(): void;
  /** Mutate to inject failures; counters self-decrement as they fire. */
  failures: FakeCloudFailures;
  /** Shared records currently in the cloud DB. */
  sharedRecords(): Promise<AnyRecord[]>;
  /** Rows in a cloud-side app-syncable table (empty if table absent). */
  appRows(appId: string, table: string): Array<Record<string, unknown>>;
  hasBlob(key: string): Promise<boolean>;
  close(): Promise<void>;
}

export async function startFakeCloud(): Promise<FakeCloud> {
  const dir = await mkdtemp(join(tmpdir(), "starkeep-fake-cloud-"));
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;

  const databaseAdapter = new SqliteDatabaseAdapter({ path: join(dir, "cloud.db") });
  await databaseAdapter.init();
  const db = databaseAdapter.getRawDatabase();
  const objectStorage = new FsObjectStorageAdapter({ basePath: join(dir, "objects") });
  await objectStorage.init();

  const clock = createHLCClock({ nodeId: `fake-cloud-${port}`, wallClockFunction: Date.now });
  const namespaceStore = new SqliteAppSyncableNamespaceStore(db);
  const applier = new SqliteAppSyncableApplier(db, namespaceStore);

  const exchangeLog: FakeCloudExchangeLogEntry[] = [];
  const failures: FakeCloudFailures = {
    exchanges: 0,
    allExchanges: false,
    blobGets: 0,
    blobPuts: 0,
  };

  // One transport per channel, mirroring the production split: the Drive
  // channel carries shared records and nothing app-specific; a per-app channel
  // carries only that app's rows.
  const transports = new Map<string, SyncTransport>();
  function transportFor(appId: string): SyncTransport {
    let transport = transports.get(appId);
    if (transport) return transport;
    transport =
      appId === "starkeep-drive"
        ? createInProcessSyncTransport({
            databaseAdapter,
            clock,
            objectStorage,
            syncSharedRecords: true,
          })
        : createInProcessSyncTransport({
            databaseAdapter,
            clock,
            objectStorage,
            syncSharedRecords: false,
            appSyncableSource: {
              namespaces: {
                get: (id: string) => namespaceStore.get(id),
                list: () => {
                  const ns = namespaceStore.get(appId);
                  return ns ? [ns] : [];
                },
              },
              applier,
            },
          });
    transports.set(appId, transport);
    return transport;
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  // Presigned-URL stand-in: the "S3" the presign endpoints point at is this
  // same server, unauthenticated, under /__blob/.
  const blobUrl = (key: string) => `${url}/__blob/${encodeURIComponent(key)}`;

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err: Error) => {
      sendJson(res, 500, { error: err.message });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? "/", url).pathname;

    if (pathname === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    const blobMatch = pathname.match(/^\/__blob\/([^/]+)$/);
    if (blobMatch) {
      const key = decodeURIComponent(blobMatch[1]!);
      if (req.method === "PUT") {
        const bytes = await readBody(req);
        const contentType = req.headers["content-type"];
        await objectStorage.put(key, bytes, {
          contentType: typeof contentType === "string" ? contentType : undefined,
        });
        res.writeHead(200);
        res.end();
        return;
      }
      if (req.method === "GET") {
        const file = await objectStorage.get(key);
        if (!file) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": file.contentType ?? "application/octet-stream",
          "Content-Length": String(file.size),
        });
        res.end(Buffer.from(file.data));
        return;
      }
      res.writeHead(405);
      res.end();
      return;
    }

    const appMatch = pathname.match(/^\/apps\/([^/]+)(\/.*)$/);
    if (!appMatch) {
      sendJson(res, 404, { error: `no route: ${req.method} ${pathname}` });
      return;
    }
    const appId = decodeURIComponent(appMatch[1]!);
    const rest = appMatch[2]!;

    if (rest === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (rest === "/sync/exchange" && req.method === "POST") {
      if (failures.allExchanges || failures.exchanges > 0) {
        if (failures.exchanges > 0) failures.exchanges -= 1;
        sendJson(res, 500, { error: "injected exchange failure" });
        return;
      }
      const request = JSON.parse((await readBody(req)).toString("utf8")) as SyncExchangeRequest;
      const response = await transportFor(appId).exchange(request);
      exchangeLog.push({
        appId,
        at: Date.now(),
        inRecords: request.records?.length ?? 0,
        inAppRows: request.appSyncableRows?.length ?? 0,
        outRecords: response.records.length,
        outAppRows: response.appSyncableRows?.length ?? 0,
      });
      sendJson(res, 200, response);
      return;
    }

    // Blob-upload path: presign, direct PUT (handled by /__blob/ above), confirm.
    if (rest === "/files/presign" && req.method === "POST") {
      if (failures.blobPuts > 0) {
        failures.blobPuts -= 1;
        sendJson(res, 500, { error: "injected blob-put failure" });
        return;
      }
      const { key } = JSON.parse((await readBody(req)).toString("utf8")) as { key: string };
      sendJson(res, 200, { url: blobUrl(key) });
      return;
    }

    if (rest === "/files/confirm" && req.method === "POST") {
      sendJson(res, 200, { ok: true });
      return;
    }

    const presignGetMatch = rest.match(/^\/files\/([^/]+)\/presign$/);
    if (presignGetMatch && req.method === "GET") {
      if (failures.blobGets > 0) {
        failures.blobGets -= 1;
        sendJson(res, 500, { error: "injected blob-get failure" });
        return;
      }
      const key = decodeURIComponent(presignGetMatch[1]!);
      if (!(await objectStorage.has(key))) {
        res.writeHead(404);
        res.end();
        return;
      }
      sendJson(res, 200, { url: blobUrl(key) });
      return;
    }

    const fileMatch = rest.match(/^\/files\/([^/]+)$/);
    if (fileMatch) {
      const key = decodeURIComponent(fileMatch[1]!);
      if (req.method === "HEAD") {
        res.writeHead((await objectStorage.has(key)) ? 200 : 404);
        res.end();
        return;
      }
      if (req.method === "DELETE") {
        await objectStorage.delete(key);
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "PUT") {
        const bytes = await readBody(req);
        const contentType = req.headers["content-type"];
        await objectStorage.put(key, bytes, {
          contentType: typeof contentType === "string" ? contentType : undefined,
        });
        res.writeHead(200);
        res.end();
        return;
      }
      if (req.method === "GET") {
        const file = await objectStorage.get(key);
        if (!file) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": file.contentType ?? "application/octet-stream",
          "Content-Length": String(file.size),
        });
        res.end(Buffer.from(file.data));
        return;
      }
    }

    sendJson(res, 404, { error: `no route: ${req.method} ${pathname}` });
  }

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  return {
    url,
    port,
    dir,
    db,
    installApp: (manifest) => installLocal(db, manifest),
    uninstallApp: (appId) => uninstallLocal(db, appId),
    exchangeLog,
    clearExchangeLog: () => {
      exchangeLog.length = 0;
    },
    failures,
    async sharedRecords() {
      const all: AnyRecord[] = [];
      let cursor: string | undefined = undefined;
      for (;;) {
        const page: { records: AnyRecord[]; nextCursor: string | null; hasMore: boolean } =
          await databaseAdapter.query({
            limit: 500,
            ...(cursor !== undefined ? { cursor } : {}),
          });
        all.push(...page.records);
        if (!page.hasMore || page.nextCursor === null) return all;
        cursor = page.nextCursor;
      }
    },
    appRows(appId, table) {
      const fullName = appSyncableTableName(appId, table);
      try {
        return db.prepare(`SELECT * FROM "${fullName}"`).all() as Array<Record<string, unknown>>;
      } catch {
        return [];
      }
    },
    hasBlob: (key) => objectStorage.has(key),
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await databaseAdapter.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
