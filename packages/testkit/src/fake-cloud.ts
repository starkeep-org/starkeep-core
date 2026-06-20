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
 *
 * Auth is accepted unconditionally *unless* a per-app secret is registered via
 * `setAppSecret(appId, secret)` — then every `/apps/{appId}/*` request (except
 * `/health`) is HMAC-verified exactly as the real cloud verifier does
 * (cloud-data-server/api-handler.ts → validateAppHmac), so a test can exercise
 * the LDS `/cloud/data/*` proxy and the sync signer against a real signature
 * check rather than a rubber stamp.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  createHLCClock,
  appSyncableObjectKey,
  type AnyRecord,
} from "@starkeep/protocol-primitives";
import { createAppSpecificFactory } from "@starkeep/shared-space-api";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
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
import { canonicalSignedPath, APP_SIG_MAX_SKEW_MS } from "@starkeep/app-client";
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
  /**
   * Register the per-app HMAC secret the cloud should verify against. Once set,
   * every `/apps/{appId}/*` request (except `/health`) must carry a valid
   * `X-Starkeep-App-{Id,Sig,Ts}` signature for that secret or it gets a 401 —
   * the same contract the real cloud verifier enforces. Registering a secret
   * that differs from the local registry's reproduces HMAC-secret drift.
   */
  setAppSecret(appId: string, hmacSecret: string): void;
  /** Shared records currently in the cloud DB. */
  sharedRecords(): Promise<AnyRecord[]>;
  /** Rows in a cloud-side app-syncable table (empty if table absent). */
  appRows(appId: string, table: string): Array<Record<string, unknown>>;
  /**
   * Write an app-private file directly on the cloud side — as if the
   * cloud-served app had called the broker's presign → upload → register
   * flow. Puts the bytes into cloud storage and writes the `_starkeep_sync_records`
   * index row, so a subsequent exchange ships it down to a local server.
   */
  setAppFile(
    appId: string,
    subKey: string,
    bytes: Buffer | string,
    mimeType?: string,
  ): Promise<{ key: string }>;
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
  // Lets tests originate an app-private file write on the cloud side (as the
  // cloud-served app would via the broker), so it can sync down to a local.
  const appFactory = createAppSpecificFactory({
    namespace: namespaceStore,
    applier,
    fileStorage: objectStorage,
    clock,
  });

  const exchangeLog: FakeCloudExchangeLogEntry[] = [];
  const failures: FakeCloudFailures = {
    exchanges: 0,
    allExchanges: false,
    blobGets: 0,
    blobPuts: 0,
  };

  // Per-app HMAC secrets. Empty by default (auth rubber-stamped); a test that
  // wants real signature checks registers the app's secret via setAppSecret.
  const appSecrets = new Map<string, string>();

  /**
   * Mirror of the real cloud verifier (cloud-data-server/api-handler.ts →
   * validateAppHmac): recompute the HMAC over
   * `${appId}:${METHOD}:${signedPath}:${ts}:` ++ raw body and compare in
   * constant time, after a freshness check on the timestamp. The signed path is
   * the per-app sub-path (everything after `/apps/{appId}`), matching what the
   * LDS proxy and sync signer sign over.
   */
  function verifyAppHmac(
    appId: string,
    method: string,
    subPath: string,
    body: Buffer,
    headers: IncomingMessage["headers"],
    secret: string,
  ): boolean {
    const sig = headers["x-starkeep-app-sig"];
    const ts = headers["x-starkeep-app-ts"];
    if (typeof sig !== "string" || typeof ts !== "string") return false;
    const tsMs = Number(ts);
    if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > APP_SIG_MAX_SKEW_MS) {
      return false;
    }
    const prefix = Buffer.from(
      `${appId}:${method.toUpperCase()}:${canonicalSignedPath(subPath)}:${tsMs}:`,
      "utf8",
    );
    const input = Buffer.concat([prefix as unknown as Uint8Array, body as unknown as Uint8Array]);
    const expected = createHmac("sha256", secret).update(input as unknown as Uint8Array).digest("hex");
    const sigBuf = Buffer.from(sig, "hex");
    const expBuf = Buffer.from(expected, "hex");
    if (sigBuf.length !== expBuf.length) return false;
    return timingSafeEqual(sigBuf as unknown as Uint8Array, expBuf as unknown as Uint8Array);
  }

  /** All non-paginated shared records currently in the cloud DB. */
  async function collectSharedRecords(): Promise<AnyRecord[]> {
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
  }

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

    // Read the body once so it's available both for HMAC verification (signed
    // over the raw bytes) and for the handlers below.
    const rawBody =
      req.method === "POST" || req.method === "PUT" ? await readBody(req) : Buffer.alloc(0);

    // Real signature check, opt-in per app via setAppSecret (see verifyAppHmac).
    // Off by default so existing rubber-stamp sync tests are unaffected.
    const registeredSecret = appSecrets.get(appId);
    if (
      registeredSecret &&
      !verifyAppHmac(appId, req.method ?? "GET", rest, rawBody, req.headers, registeredSecret)
    ) {
      sendJson(res, 401, { error: "Invalid signature" });
      return;
    }

    if (rest === "/sync/exchange" && req.method === "POST") {
      if (failures.allExchanges || failures.exchanges > 0) {
        if (failures.exchanges > 0) failures.exchanges -= 1;
        sendJson(res, 500, { error: "injected exchange failure" });
        return;
      }
      const request = JSON.parse(rawBody.toString("utf8")) as SyncExchangeRequest;
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
      const { key } = JSON.parse(rawBody.toString("utf8")) as { key: string };
      sendJson(res, 200, { url: blobUrl(key) });
      return;
    }

    if (rest === "/files/confirm" && req.method === "POST") {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Read endpoints the LDS `/cloud/data/*` proxy targets. Mirror the real
    // cloud-data-server (api-handler.ts) response shape so a Drive client
    // reading the cloud-side view through the proxy gets the same contract.
    // Drive has all-access, so these scan every shared record.
    if (rest === "/data/types" && req.method === "GET") {
      const records = (await collectSharedRecords()).filter((r) => !r.deletedAt);
      const counts = new Map<string, number>();
      for (const r of records) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
      const types = Array.from(counts.entries()).map(([record_type, count]) => ({
        record_type,
        count,
      }));
      sendJson(res, 200, { types, total: records.length });
      return;
    }

    if (rest === "/data/records" && req.method === "GET") {
      const typeFilter = new URL(req.url ?? "/", url).searchParams.get("type") ?? undefined;
      const records = (await collectSharedRecords()).filter(
        (r) => !r.deletedAt && (typeFilter === undefined || r.type === typeFilter),
      );
      sendJson(res, 200, { records, hasMore: false, nextCursor: null });
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
        const contentType = req.headers["content-type"];
        await objectStorage.put(key, rawBody, {
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
    setAppSecret: (appId, hmacSecret) => {
      appSecrets.set(appId, hmacSecret);
    },
    sharedRecords: () => collectSharedRecords(),
    appRows(appId, table) {
      const fullName = appSyncableTableName(appId, table);
      try {
        return db.prepare(`SELECT * FROM "${fullName}"`).all() as Array<Record<string, unknown>>;
      } catch {
        return [];
      }
    },
    async setAppFile(appId, subKey, bytes, mimeType = "application/octet-stream") {
      const view = appFactory({ subjectType: "app", subjectId: appId });
      if (!view) throw new Error(`fake-cloud: app "${appId}" not installed`);
      const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      const key = appSyncableObjectKey(appId, subKey);
      await objectStorage.put(key, body, { contentType: mimeType });
      return view.registerFile(subKey, {
        contentHash: createHash("sha256").update(body as unknown as Uint8Array).digest("hex"),
        mimeType,
        sizeBytes: body.length,
      });
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
