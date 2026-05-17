/**
 * Local data server for the Starkeep admin desktop app.
 * Exposes the SDK over HTTP with owner-level access so the admin
 * browses data through proper access control, not by reading the DB directly.
 */

import { createServer } from "node:http";
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  installLocal,
  uninstallLocal,
  LocalInstallError,
  ManifestValidationError,
} from "../../packages/admin-installer/src/local/installer.js";
import {
  listAppRegistry,
  appRegistryRow,
} from "../../packages/admin-installer/src/local/registry.js";
import { SqliteDatabaseAdapter } from "../../packages/storage-sqlite/src/adapter.js";
import {
  createSqliteAccessPolicyStore,
  createSqliteTypeRegistrationStore,
  listAppSyncableNamespaces,
  SqliteAppSyncableNamespaceStore,
  SqliteAppSyncableApplier,
} from "../../packages/storage-sqlite/src/index.js";
import { createAppSpecificFactory } from "../../packages/shared-space-api/src/app-syncable/factory.js";
import { disabledSharingTokenStore } from "../../packages/access-control/src/stores.js";
import { FsObjectStorageAdapter } from "../../packages/storage-fs/src/adapter.js";
import { S3ObjectStorageAdapter } from "../../packages/storage-s3/src/adapter.js";
import { AuroraDsqlDatabaseAdapter } from "../../packages/storage-aurora-dsql/src/adapter.js";
import type { ObjectStorageAdapter } from "../../packages/storage-adapter/src/object-storage/adapter.js";
import type { DatabaseAdapter } from "../../packages/storage-adapter/src/database/adapter.js";
import type {
  DatabaseClientFactory,
  DatabaseClient,
  AuroraDsqlDatabaseAdapterOptions,
} from "../../packages/storage-aurora-dsql/src/types.js";
import { createStarkeepSdk } from "../../packages/sdk/src/sdk.js";
import {
  createHttpSyncTransport,
  createSqliteChangeLog,
  createSqliteSyncStateStore,
} from "../../packages/sync-engine/src/index.js";
import { WILDCARD_EXPANDABLE_TYPE_IDS, CORE_TYPES } from "../../packages/core/src/types/core-types.js";
import { createHLCClock, serializeHLC } from "../../packages/core/src/hlc/index.js";
import { dataRecordObjectKey } from "../../packages/core/src/storage/object-keys.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { stat as fsStat, readFile, writeFile, mkdir, unlink, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createFileWatchManager } from "./watcher.js";
import { HttpObjectStorageAdapter } from "./http-object-storage.js";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import pg from "pg";
import {
  type CognitoConfig,
  type STSCredentials,
  initiateAuth,
  respondNewPasswordChallenge,
  getIdentityPoolCredentials,
  startCredentialRefreshTimer,
} from "./cognito-auth.js";

// Signing key for self-hosted file tokens — regenerated each startup so
// all outstanding tokens are invalidated on restart (revocable by design).
const TOKEN_SECRET = randomBytes(32);

const STARKEEP_DIR = process.env.STARKEEP_DIR || join(homedir(), ".starkeep");
const PORT = parseInt(process.env.STARKEEP_PORT || "9820", 10);
const OWNER_ID = process.env.STARKEEP_OWNER_ID || "craig";
const NODE_ID = process.env.STARKEEP_NODE_ID || "admin-desktop";
const PULL_INTERVAL_MS = parseInt(process.env.STARKEEP_PULL_INTERVAL_MS || "30000", 10);
const PUSH_DEBOUNCE_MS = parseInt(process.env.STARKEEP_PUSH_DEBOUNCE_MS || "500", 10);
// ---------------------------------------------------------------------------
// Per-app access enforcement — backed by shared_app_registry + shared_access_grants
// in the local sqlite DB. Populated by the installer (POST /admin/apps/install).
// ---------------------------------------------------------------------------

type GrantAccess = "read" | "readwrite";

interface AppGrantRow {
  type_id: string;
  access: GrantAccess;
  metadata_write: number;
}

function expandGrantsForApp(db: DatabaseSync, appId: string): AppGrantRow[] {
  const rows = db
    .prepare(
      "SELECT type_id, access, metadata_write FROM shared_access_grants WHERE app_id = ?",
    )
    .all(appId) as unknown as AppGrantRow[];
  // Wildcard expansion: '*' grants the access level on every registered core type
  // except 'unknown' (which is gated by canIngestUnknown / canPromoteFromUnknown
  // and lives on the manifest, not access_grants).
  const out: AppGrantRow[] = [];
  for (const row of rows) {
    if (row.type_id === "*") {
      for (const t of WILDCARD_EXPANDABLE_TYPE_IDS) {
        out.push({ type_id: t, access: row.access, metadata_write: row.metadata_write });
      }
    } else {
      out.push(row);
    }
  }
  return out;
}

function appCanRead(db: DatabaseSync, appId: string, type: string): boolean {
  const grants = expandGrantsForApp(db, appId);
  return grants.some((g) => g.type_id === type);
}

function appCanWrite(db: DatabaseSync, appId: string, type: string): boolean {
  const grants = expandGrantsForApp(db, appId);
  return grants.some((g) => g.type_id === type && g.access === "readwrite");
}

function appCanWriteMetadata(db: DatabaseSync, appId: string, type: string): boolean {
  const grants = expandGrantsForApp(db, appId);
  return grants.some((g) => g.type_id === type && g.metadata_write === 1);
}

function getAppHmacSecret(db: DatabaseSync, appId: string): string | null {
  const row = db
    .prepare("SELECT hmac_secret FROM shared_app_registry WHERE app_id = ? AND status = 'active'")
    .get(appId) as { hmac_secret: string } | undefined;
  return row?.hmac_secret ?? null;
}

function validateAppHmac(db: DatabaseSync, appId: string, body: string, sig: string | undefined): boolean {
  if (!sig) return false;
  const secret = getAppHmacSecret(db, appId);
  if (!secret) return false;
  const expected = createHmac("sha256", secret).update(`${appId}:${body}`).digest("hex");
  // timingSafeEqual requires equal-length buffers
  const sigBuf = Buffer.from(sig, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expBuf.length) return false;
  return timingSafeEqual(sigBuf, expBuf);
}

// Path to starkeep-config.json — resolved relative to this file so it works
// regardless of cwd. Override via STARKEEP_CONFIG env var for non-standard layouts.
const STARKEEP_CONFIG_PATH =
  process.env.STARKEEP_CONFIG ??
  fileURLToPath(new URL("../../starkeep-config.json", import.meta.url));

interface StarkeepConfig {
  stage: string;
  userPoolId: string;
  userPoolClientId: string;
  identityPoolId: string;
  s3Bucket?: string;
  s3Region?: string;
  auroraEndpoint?: string;
  apiGatewayUrl?: string;
}

function regionFromUserPoolId(userPoolId: string): string {
  const parts = userPoolId.split("_");
  return parts.length > 1 ? parts[0] : "";
}

interface CloudCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

interface PersistedAuth {
  refreshToken: string;
  idToken?: string;
}

function restartProcess(): void {
  console.log("[server] Restarting to apply config changes…");
  const child = spawn(process.execPath, process.argv.slice(1), {
    detached: true,
    stdio: "inherit",
    env: process.env,
    cwd: process.cwd(),
  });
  child.unref();
  process.exit(0);
}

const WATCHES_CONFIG_PATH = join(STARKEEP_DIR, "watches.json");

async function loadWatchConfigs(): Promise<import("./watcher.js").WatchConfig[]> {
  try {
    return JSON.parse(await readFile(WATCHES_CONFIG_PATH, "utf8"));
  } catch {
    return [];
  }
}

async function saveWatchConfigs(configs: import("./watcher.js").WatchConfig[]): Promise<void> {
  await mkdir(STARKEEP_DIR, { recursive: true });
  await writeFile(WATCHES_CONFIG_PATH, JSON.stringify(configs, null, 2), "utf8");
}

async function loadStarkeepConfig(): Promise<StarkeepConfig | null> {
  try {
    return JSON.parse(await readFile(STARKEEP_CONFIG_PATH, "utf8")) as StarkeepConfig;
  } catch {
    console.warn(`No starkeep-config.json found at ${STARKEEP_CONFIG_PATH} — cloud features disabled`);
    return null;
  }
}

async function loadPersistedAuth(): Promise<PersistedAuth | null> {
  try {
    return JSON.parse(await readFile(join(STARKEEP_DIR, "auth.json"), "utf8")) as PersistedAuth;
  } catch {
    return null;
  }
}

async function savePersistedAuth(auth: PersistedAuth): Promise<void> {
  await mkdir(STARKEEP_DIR, { recursive: true });
  await writeFile(join(STARKEEP_DIR, "auth.json"), JSON.stringify(auth, null, 2), "utf8");
}

async function loadIdToken(): Promise<string | null> {
  try {
    const auth = JSON.parse(await readFile(join(STARKEEP_DIR, "auth.json"), "utf8")) as PersistedAuth;
    return auth.idToken ?? null;
  } catch {
    return null;
  }
}

async function saveCloudCredentials(creds: STSCredentials): Promise<void> {
  await mkdir(STARKEEP_DIR, { recursive: true });
  await writeFile(join(STARKEEP_DIR, "cloud-credentials.json"), JSON.stringify(creds, null, 2), "utf8");
}

/**
 * Reads STS credentials from ~/.starkeep/cloud-credentials.json on every call
 * so that credentials rotated externally are always picked up without restarting.
 */
async function makeCloudCredentialProvider(): Promise<() => Promise<CloudCredentials>> {
  const credentialsPath = join(STARKEEP_DIR, "cloud-credentials.json");
  return async () => {
    let raw: STSCredentials;
    try {
      raw = JSON.parse(await readFile(credentialsPath, "utf8")) as STSCredentials;
    } catch {
      throw new Error("No cloud credentials — sign in to continue");
    }
    return {
      accessKeyId: raw.accessKeyId,
      secretAccessKey: raw.secretAccessKey,
      sessionToken: raw.sessionToken,
      expiration: raw.expiration ? new Date(raw.expiration) : undefined,
    };
  };
}

/**
 * Aurora DSQL client factory that reads STS credentials from the cloud
 * credentials file on each reconnect so rotating tokens are always fresh.
 */
class CloudCredentialsDsqlClientFactory implements DatabaseClientFactory {
  private readonly credentialsPath: string;

  constructor() {
    this.credentialsPath = join(STARKEEP_DIR, "cloud-credentials.json");
  }

  async createClient(
    options: AuroraDsqlDatabaseAdapterOptions,
  ): Promise<DatabaseClient> {
    const createPgClient = async (): Promise<pg.Client> => {
      let rawCreds: CloudCredentials;
      try {
        rawCreds = JSON.parse(await readFile(this.credentialsPath, "utf8")) as CloudCredentials;
      } catch {
        throw new Error("No cloud credentials — sign in to continue");
      }
      const signer = new DsqlSigner({
        hostname: options.hostname,
        region: options.region,
        credentials: {
          accessKeyId: rawCreds.accessKeyId,
          secretAccessKey: rawCreds.secretAccessKey,
          sessionToken: rawCreds.sessionToken,
        },
      });
      const token = await signer.getDbConnectAdminAuthToken();
      const client = new pg.Client({
        host: options.hostname,
        port: 5432,
        database: options.database ?? "postgres",
        user: "admin",
        password: token,
        ssl: { rejectUnauthorized: true },
      });
      await client.connect();
      return client;
    };

    let inner = await createPgClient();

    return {
      async query(text, values) {
        try {
          const result = await inner.query(text, values);
          return { rows: result.rows };
        } catch (err: unknown) {
          // IAM auth token expired (~15 min) — reconnect with fresh token and retry once
          const code = (err as { code?: string })?.code;
          if (code === "28000" || code === "28P01") {
            await inner.end().catch(() => {});
            inner = await createPgClient();
            const result = await inner.query(text, values);
            return { rows: result.rows };
          }
          throw err;
        }
      },
      async end() {
        await inner.end();
      },
    };
  }
}

async function main() {
  const databaseAdapter = new SqliteDatabaseAdapter({
    path: join(STARKEEP_DIR, "data.db"),
  });

  // Local FS is always available — acts as a cache when S3 is configured
  const objectsBasePath = join(STARKEEP_DIR, "objects");
  const localAdapter = new FsObjectStorageAdapter({
    basePath: objectsBasePath,
  });

  // Load cloud config from starkeep-config.json at the repo root
  const starkeepConfig = await loadStarkeepConfig();
  const configRegion = starkeepConfig ? regionFromUserPoolId(starkeepConfig.userPoolId) : "";
  if (starkeepConfig) {
    console.log(`Cloud config loaded: stage=${starkeepConfig.stage}, region=${configRegion}`);
    if (starkeepConfig.s3Bucket) console.log(`  S3 bucket=${starkeepConfig.s3Bucket}`);
    if (starkeepConfig.auroraEndpoint) console.log(`  DSQL=${starkeepConfig.auroraEndpoint}`);
    if (starkeepConfig.apiGatewayUrl) console.log(`  API=${starkeepConfig.apiGatewayUrl}`);
  }

  // CLOUD_URL: env var takes precedence, then fall back to apiGatewayUrl from config
  const CLOUD_URL = process.env.STARKEEP_CLOUD_URL ?? starkeepConfig?.apiGatewayUrl ?? undefined;

  // Persistent auth: if a stored refresh token exists, start credential rotation
  const persistedAuth = await loadPersistedAuth();
  let currentRefreshToken: string | null = persistedAuth?.refreshToken ?? null;
  let currentIdToken: string | null = await loadIdToken();
  let stopCredentialRefresh: (() => void) | null = null;

  const cognitoConfig: CognitoConfig | null = starkeepConfig
    ? {
        region: configRegion,
        userPoolId: starkeepConfig.userPoolId,
        userPoolClientId: starkeepConfig.userPoolClientId,
        identityPoolId: starkeepConfig.identityPoolId,
      }
    : null;

  if (cognitoConfig && currentRefreshToken) {
    console.log("Stored auth found — starting credential refresh timer");
    stopCredentialRefresh = startCredentialRefreshTimer(
      cognitoConfig,
      () => currentRefreshToken,
      async (creds) => {
        await saveCloudCredentials(creds);
        console.log("Cloud credentials refreshed");
      },
      (err) => console.error("Credential refresh failed:", err.message),
      async (idToken) => {
        currentIdToken = idToken;
        await savePersistedAuth({ refreshToken: currentRefreshToken!, idToken });
      },
    );
  }

  // S3: use starkeep-config.json values when available, otherwise fall back to env vars
  let remoteAdapter: ObjectStorageAdapter | null = null;
  if (starkeepConfig?.s3Bucket) {
    const credentialProvider = await makeCloudCredentialProvider();
    remoteAdapter = new S3ObjectStorageAdapter({
      bucketName: starkeepConfig.s3Bucket,
      region: starkeepConfig.s3Region ?? configRegion,
      credentialProvider,
    });
    console.log("Remote S3 adapter initialized from cloud config");
  } else {
    const s3Bucket = process.env.STARKEEP_S3_BUCKET;
    if (s3Bucket) {
      remoteAdapter = new S3ObjectStorageAdapter({
        bucketName: s3Bucket,
        region: process.env.STARKEEP_S3_REGION || "us-east-1",
        keyPrefix: process.env.STARKEEP_S3_KEY_PREFIX || undefined,
        credentials:
          process.env.STARKEEP_S3_ACCESS_KEY_ID &&
          process.env.STARKEEP_S3_SECRET_ACCESS_KEY
            ? {
                accessKeyId: process.env.STARKEEP_S3_ACCESS_KEY_ID,
                secretAccessKey: process.env.STARKEEP_S3_SECRET_ACCESS_KEY,
              }
            : undefined,
      });
    }
  }

  // Aurora DSQL remote database: initialized from cloud config when available
  let remoteDatabaseAdapter: DatabaseAdapter | null = null;
  if (starkeepConfig?.auroraEndpoint) {
    remoteDatabaseAdapter = new AuroraDsqlDatabaseAdapter(
      {
        hostname: starkeepConfig.auroraEndpoint,
        region: starkeepConfig.s3Region ?? configRegion,
      },
      new CloudCredentialsDsqlClientFactory(),
    );
    await remoteDatabaseAdapter.init().catch((err: Error) =>
      console.error("Aurora DSQL init failed (non-fatal):", err.message),
    );
    console.log("Remote Aurora DSQL adapter initialized from cloud config");
  }

  // App identities are stored in shared_app_registry; populated by the
  // installer (POST /admin/apps/install). No startup-time auto-discovery —
  // apps appear only after going through install.

  const clock = createHLCClock({ nodeId: NODE_ID, wallClockFunction: Date.now });

  // Pre-init so we can hand the raw SQLite handle to the sync change log +
  // state store, which share the records DB file.
  await databaseAdapter.init();

  const syncTransport = CLOUD_URL
    ? createHttpSyncTransport({
        baseUrl: CLOUD_URL,
        getAuthHeader: () => (currentIdToken ? `Bearer ${currentIdToken}` : undefined),
      })
    : undefined;
  const syncRemoteStorage: ObjectStorageAdapter | undefined = CLOUD_URL
    ? new HttpObjectStorageAdapter({
        baseUrl: `${CLOUD_URL}/files`,
        getAuthHeader: () => (currentIdToken ? `Bearer ${currentIdToken}` : undefined),
      })
    : undefined;
  const syncChangeLog = createSqliteChangeLog({ db: databaseAdapter.getRawDatabase() });
  const syncStateStore = CLOUD_URL
    ? createSqliteSyncStateStore({ db: databaseAdapter.getRawDatabase() })
    : undefined;

  // Direct sqlite handle for app-identity / grant lookups. The records-layer
  // adapter operates on the same DB; we use raw access for the shared_*
  // tables (registry, grants) that have no adapter wrapper.
  const localDb = databaseAdapter.getRawDatabase();

  const accessPolicyStore = createSqliteAccessPolicyStore(localDb);
  const typeRegistrationStore = createSqliteTypeRegistrationStore(localDb);

  const namespaceStore = new SqliteAppSyncableNamespaceStore(localDb);
  const appApplier = new SqliteAppSyncableApplier(localDb, namespaceStore);

  const appSpecificFactory = createAppSpecificFactory({
    namespace: namespaceStore,
    applier: appApplier,
    fileStorage: localAdapter,
    buildFileUrl: (key, mimeType, expiresIn) => {
      const token = createFileToken(key, mimeType, expiresIn);
      return `http://127.0.0.1:${PORT}/data/files/${token}`;
    },
    clock,
  });

  async function listAppSyncableFiles() {
    const namespaces = listAppSyncableNamespaces(localDb);
    const entries: { key: string }[] = [];
    for (const ns of namespaces) {
      if (!ns.filesEnabled) continue;
      const result = await localAdapter.list(`apps/${ns.appId}/syncable/`);
      for (const key of result.keys) entries.push({ key });
    }
    return entries;
  }

  const sdk = await createStarkeepSdk({
    databaseAdapter,
    objectStorageAdapter: localAdapter,
    accessPolicyStore,
    // Tokens are issued and validated cloud-side only — local has no
    // sharing_tokens table. This stub throws on every call so anything that
    // tries to issue locally fails loudly.
    sharingTokenStore: disabledSharingTokenStore(),
    typeRegistrationStore,
    ownerId: OWNER_ID,
    nodeId: NODE_ID,
    syncTransport,
    remoteObjectStorageAdapter: syncRemoteStorage,
    syncChangeLog,
    syncStateStore,
    getAppSpecific: appSpecificFactory,
    listAppSyncableFiles,
    appSyncableSource: { namespaces: namespaceStore, applier: appApplier },
  });

  const syncRuntime = {
    lastPullAt: null as string | null,
    lastPushAt: null as string | null,
    lastError: null as string | null,
    pullBackoffMs: PULL_INTERVAL_MS,
    syncPaused: false,
  };

  let pushTimer: NodeJS.Timeout | null = null;
  function schedulePush(): void {
    if (!sdk.sync) return;
    if (syncRuntime.syncPaused) return;
    if (pushTimer) return;
    pushTimer = setTimeout(async () => {
      pushTimer = null;
      try {
        await sdk.sync!.push();
        syncRuntime.lastPushAt = new Date().toISOString();
        syncRuntime.lastError = null;
      } catch (err) {
        syncRuntime.lastError = (err as Error).message;
        console.error("push failed:", err);
      }
    }, PUSH_DEBOUNCE_MS);
  }

  const sseClients = new Set<import("node:http").ServerResponse>();
  setInterval(() => {
    for (const client of sseClients) client.write(": ping\n\n");
  }, 25_000);

  if (sdk.sync) {
    sdk.sync.onUpdate((event) => {
      console.log(`[sync] ${event.eventType} records=${event.recordIds.length}`);
      if (event.eventType === "local-change-recorded") {
        schedulePush();
      }
      const payload = JSON.stringify(event);
      for (const client of sseClients) client.write(`data: ${payload}\n\n`);
    });
  }

  let pullTimer: NodeJS.Timeout | null = null;
  async function runPull(): Promise<void> {
    if (!sdk.sync) return;
    try {
      await sdk.sync.pull();
      syncRuntime.lastPullAt = new Date().toISOString();
      syncRuntime.lastError = null;
      syncRuntime.pullBackoffMs = PULL_INTERVAL_MS;
    } catch (err) {
      syncRuntime.lastError = (err as Error).message;
      syncRuntime.pullBackoffMs = Math.min(syncRuntime.pullBackoffMs * 2, 5 * 60 * 1000);
      console.error("pull failed:", err);
    }
    if (!syncRuntime.syncPaused) {
      pullTimer = setTimeout(runPull, syncRuntime.pullBackoffMs);
    }
  }
  if (sdk.sync) {
    pullTimer = setTimeout(runPull, PULL_INTERVAL_MS);
  }

  // Built-in watcher identity: register it in shared_app_registry just like an
  // external app, so its writes have a valid origin_app_id and so its grants
  // flow through the same access-control path. No user consent — it's part of
  // the local-data-server itself.
  const watcherManifest = {
    id: "@starkeep/watcher",
    name: "Local Watcher",
    version: "1.0.0",
    tier: "official" as const,
    infraRequirements: {
      sharedTypeAccess: [
        {
          typeId: "*",
          access: "readwrite" as const,
          rationale: "Built-in file watcher ingests arbitrary files into all shared types.",
        },
      ],
      canIngestUnknown: true,
    },
  };
  const { appId: watcherAppId } = installLocal(localDb, watcherManifest);

  // File watch manager — monitors local directories and syncs to Starkeep
  const watchManager = createFileWatchManager({
    sdk,
    db: databaseAdapter.getRawDatabase(),
    databaseAdapter,
    ownerId: OWNER_ID,
    appId: watcherAppId,
  });

  // Restore persisted watches from local config file
  const persistedWatches = await loadWatchConfigs();
  for (const config of persistedWatches) {
    watchManager.startWatch(config).catch((err: Error) =>
      console.error(`Failed to restore watch ${config.id}:`, err.message)
    );
  }

  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Starkeep-App-Id, X-Starkeep-App-Sig");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://localhost:${PORT}`);
    const path = url.pathname;

    // Per-request app identity. Required for every data/sync/watches request:
    // the local-data-server enforces app-scoped access on top of the same
    // (currently unused) cloud identity flow. Admin & system endpoints that
    // belong to admin-web rather than an installed app are exempt below.
    const appId = req.headers["x-starkeep-app-id"] as string | undefined;
    const appSig = req.headers["x-starkeep-app-sig"] as string | undefined;

    // Watches are an admin/host concern (configured via admin-web, not by
     // installed apps), so they intentionally do not require app HMAC headers.
    // `/data/files/:token` is also exempt — the signed token in the path is
    // the authorization, and the URL is meant to be embeddable (e.g. in <img src>).
    const APP_AUTH_REQUIRED_PREFIXES = ["/data/", "/sync/", "/app-data/"];
    const APP_AUTH_EXEMPT_PATTERNS = [/^\/data\/files\/[^/]+$/];
    const requiresAppAuth =
      APP_AUTH_REQUIRED_PREFIXES.some((p) =>
        path === p.replace(/\/$/, "") || path.startsWith(p),
      ) && !APP_AUTH_EXEMPT_PATTERNS.some((re) => re.test(path));

    if (requiresAppAuth) {
      if (!appId) {
        res.writeHead(401);
        json(res, { error: "X-Starkeep-App-Id header required" });
        return;
      }
      const rawBody =
        req.method === "GET" || req.method === "HEAD" ? "" : await readBody(req);
      if (!validateAppHmac(localDb, appId, rawBody, appSig)) {
        res.writeHead(401);
        json(res, { error: "Invalid X-Starkeep-App-Sig (app not installed or signature mismatch)" });
        return;
      }
      // readBody caches the raw bytes on the request itself, so downstream
      // handlers calling readBody or readBodyBuffer hit the cache.
    }

    try {
      if (path === "/health") {
        json(res, { status: "ok" });
        return;
      }

      if (path === "/config" && req.method === "GET") {
        const freshConfig = await loadStarkeepConfig();
        if (!freshConfig) {
          res.writeHead(404);
          json(res, { error: "No cloud config loaded" });
          return;
        }
        const freshRegion = regionFromUserPoolId(freshConfig.userPoolId);
        json(res, {
          stage: freshConfig.stage,
          s3Bucket: freshConfig.s3Bucket ?? null,
          s3Region: freshConfig.s3Region ?? freshRegion,
          auroraEndpoint: freshConfig.auroraEndpoint ?? null,
          apiGatewayUrl: freshConfig.apiGatewayUrl ?? null,
          cognitoConfig: {
            region: freshRegion,
            userPoolId: freshConfig.userPoolId,
            userPoolClientId: freshConfig.userPoolClientId,
            identityPoolId: freshConfig.identityPoolId,
          },
        });
        return;
      }

      if (path === "/config" && req.method === "PATCH") {
        if (!starkeepConfig) {
          res.writeHead(404);
          json(res, { error: "No cloud config loaded" });
          return;
        }
        const patch = JSON.parse(await readBody(req)) as Partial<StarkeepConfig>;
        const updated: StarkeepConfig = { ...starkeepConfig, ...patch };
        await writeFile(STARKEEP_CONFIG_PATH, JSON.stringify(updated, null, 2), "utf8");
        Object.assign(starkeepConfig, patch);
        json(res, { ok: true });
        setTimeout(restartProcess, 200);
        return;
      }

      if (path === "/auth/status" && req.method === "GET") {
        json(res, {
          configLoaded: cognitoConfig !== null,
          authenticated: currentRefreshToken !== null,
        });
        return;
      }

      if (path === "/auth/login" && req.method === "POST") {
        if (!cognitoConfig) {
          res.writeHead(503);
          json(res, { error: "No starkeep-config.json found — cannot authenticate" });
          return;
        }
        const body = JSON.parse(await readBody(req)) as {
          email: string;
          password: string;
          newPassword?: string;
        };
        if (!body.email || !body.password) {
          res.writeHead(400);
          json(res, { error: "email and password are required" });
          return;
        }

        let authResult = await initiateAuth(cognitoConfig, body.email, body.password);

        if (authResult.challengeName === "NEW_PASSWORD_REQUIRED") {
          if (!body.newPassword) {
            json(res, { challenge: "NEW_PASSWORD_REQUIRED" });
            return;
          }
          const tokens = await respondNewPasswordChallenge(
            cognitoConfig,
            authResult.session!,
            body.email,
            body.newPassword,
          );
          authResult = { tokens };
        }

        if (!authResult.tokens) {
          res.writeHead(400);
          json(res, { error: `Unhandled auth challenge: ${authResult.challengeName}` });
          return;
        }

        const creds = await getIdentityPoolCredentials(cognitoConfig, authResult.tokens.idToken);
        currentRefreshToken = authResult.tokens.refreshToken;
        currentIdToken = authResult.tokens.idToken;
        await savePersistedAuth({ refreshToken: currentRefreshToken, idToken: currentIdToken });
        await saveCloudCredentials(creds);

        // (Re)start credential refresh timer
        stopCredentialRefresh?.();
        stopCredentialRefresh = startCredentialRefreshTimer(
          cognitoConfig,
          () => currentRefreshToken,
          async (newCreds) => {
            await saveCloudCredentials(newCreds);
            console.log("Cloud credentials refreshed");
          },
          (err) => console.error("Credential refresh failed:", err.message),
          async (idToken) => {
            currentIdToken = idToken;
            await savePersistedAuth({ refreshToken: currentRefreshToken!, idToken });
          },
        );

        json(res, { ok: true });
        return;
      }

      if (path === "/auth/tokens" && req.method === "POST") {
        if (!cognitoConfig) {
          res.writeHead(503);
          json(res, { error: "No cloud config loaded — cannot authenticate" });
          return;
        }
        const body = JSON.parse(await readBody(req)) as { idToken: string; refreshToken: string };
        if (!body.idToken || !body.refreshToken) {
          res.writeHead(400);
          json(res, { error: "idToken and refreshToken are required" });
          return;
        }
        const creds = await getIdentityPoolCredentials(cognitoConfig, body.idToken);
        currentRefreshToken = body.refreshToken;
        currentIdToken = body.idToken;
        await savePersistedAuth({ refreshToken: currentRefreshToken, idToken: currentIdToken });
        await saveCloudCredentials(creds);
        stopCredentialRefresh?.();
        stopCredentialRefresh = startCredentialRefreshTimer(
          cognitoConfig,
          () => currentRefreshToken,
          async (newCreds) => {
            await saveCloudCredentials(newCreds);
            console.log("Cloud credentials refreshed");
          },
          (err) => console.error("Credential refresh failed:", err.message),
          async (idToken) => {
            currentIdToken = idToken;
            await savePersistedAuth({ refreshToken: currentRefreshToken!, idToken });
          },
        );
        json(res, { ok: true });
        return;
      }

      if (path === "/auth/logout" && req.method === "POST") {
        stopCredentialRefresh?.();
        stopCredentialRefresh = null;
        currentRefreshToken = null;
        currentIdToken = null;
        for (const file of ["auth.json", "cloud-credentials.json", "cloud-config.json"]) {
          await unlink(join(STARKEEP_DIR, file)).catch(() => {});
        }
        console.log("Auth cleared");
        json(res, { ok: true });
        return;
      }

      // Sync observability + manual trigger
      if (path === "/sync/status" && req.method === "GET") {
        json(res, {
          enabled: sdk.sync !== null,
          syncPaused: syncRuntime.syncPaused,
          cloudUrl: CLOUD_URL ?? null,
          lastPullAt: syncRuntime.lastPullAt,
          lastPushAt: syncRuntime.lastPushAt,
          lastError: syncRuntime.lastError,
          pullBackoffMs: syncRuntime.pullBackoffMs,
          conflictCount: sdk.sync ? sdk.sync.getConflicts().length : 0,
        });
        return;
      }

      if (path === "/sync/pause" && req.method === "POST") {
        if (!sdk.sync) {
          res.writeHead(400);
          json(res, { error: "sync not configured" });
          return;
        }
        syncRuntime.syncPaused = true;
        if (pullTimer) { clearTimeout(pullTimer); pullTimer = null; }
        if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
        json(res, { ok: true });
        return;
      }

      if (path === "/sync/resume" && req.method === "POST") {
        if (!sdk.sync) {
          res.writeHead(400);
          json(res, { error: "sync not configured" });
          return;
        }
        syncRuntime.syncPaused = false;
        sdk.sync.fullSync().then(() => {
          syncRuntime.lastPullAt = new Date().toISOString();
          syncRuntime.lastPushAt = new Date().toISOString();
          syncRuntime.lastError = null;
          syncRuntime.pullBackoffMs = PULL_INTERVAL_MS;
        }).catch((err: Error) => {
          syncRuntime.lastError = err.message;
          console.error("resume fullSync failed:", err);
        });
        pullTimer = setTimeout(runPull, syncRuntime.pullBackoffMs);
        json(res, { ok: true });
        return;
      }

      if (path === "/sync/now" && req.method === "POST") {
        if (!sdk.sync) {
          res.writeHead(400);
          json(res, { error: "sync not configured" });
          return;
        }
        const result = await sdk.sync.fullSync();
        syncRuntime.lastPullAt = new Date().toISOString();
        syncRuntime.lastPushAt = new Date().toISOString();
        json(res, result);
        return;
      }

      if (path === "/sync/conflicts" && req.method === "GET") {
        if (!sdk.sync) {
          json(res, { conflicts: [] });
          return;
        }
        json(res, { conflicts: sdk.sync.getConflicts() });
        return;
      }

      const resolveMatch = path.match(/^\/sync\/conflicts\/([^/]+)\/resolve$/);
      if (resolveMatch && req.method === "POST") {
        if (!sdk.sync) {
          res.writeHead(400);
          json(res, { error: "sync not configured" });
          return;
        }
        const body = JSON.parse(await readBody(req));
        if (body.keep !== "local" && body.keep !== "server") {
          res.writeHead(400);
          json(res, { error: 'body must include { keep: "local" | "server" }' });
          return;
        }
        const record = await sdk.data.resolveConflict(
          resolveMatch[1]! as any,
          { keep: body.keep },
        );
        schedulePush();
        json(res, { record });
        return;
      }

      // GET /browse?path=/ — hierarchical folder view for File Provider
      // Root shows: watched directories as folders + "Library" for untracked records
      // Subpaths show: actual subfolder structure from watched directories
      if (path === "/browse" && req.method === "GET") {
        const browsePath = url.searchParams.get("path") || "/";

        if (browsePath === "/") {
          // Root: list watched directories as folders + Library folder
          const watches = watchManager.getAllStatuses();
          const folders: { name: string; id: string; type: "watch" | "virtual"; itemCount: number }[] = [];

          for (const w of watches) {
            const dirName = w.directoryPath.split("/").pop() || w.directoryPath;
            folders.push({ name: dirName, id: `watch:${w.id}`, type: "watch", itemCount: w.syncedFiles });
          }

          // Check for records not in any watch (Library)
          const allData = await databaseAdapter.query({ limit: 100000 });
          const watchFileIds = new Set<string>();
          const unwatchedRecords: typeof allData.records = [];
          for (const r of allData.records) {
            if (r.deletedAt) continue;
            // Check if this record is referenced by a watch-file
            const isWatched = watchManager.getAllStatuses().some(w => {
              const files = watchManager.getWatchFiles(w.id);
              return files.some(f => f.dataRecordId === r.id);
            });
            if (!isWatched) unwatchedRecords.push(r);
          }

          if (unwatchedRecords.length > 0) {
            folders.push({ name: "Library", id: "virtual:library", type: "virtual", itemCount: unwatchedRecords.length });
          }

          json(res, { path: "/", folders, files: [] });
          return;
        }

        // /watch:<watchId> or /watch:<watchId>/subfolder/path
        const watchMatch = browsePath.match(/^\/watch:([^/]+)(\/.*)?$/);
        if (watchMatch) {
          const watchId = watchMatch[1]!;
          const subPath = (watchMatch[2] || "").replace(/^\//, "");
          const allFiles = watchManager.getWatchFiles(watchId);
          const status = watchManager.getStatus(watchId);

          // Collect immediate children at this subpath level
          const folders = new Set<string>();
          const files: { name: string; relativePath: string; recordId: string; contentHash: string }[] = [];

          for (const f of allFiles) {
            const rel = f.relativePath;
            // Check if this file is within the subpath
            if (subPath && !rel.startsWith(subPath + "/") && rel !== subPath) continue;
            const remainder = subPath ? rel.slice(subPath.length + 1) : rel;
            if (!remainder) continue;

            const slashIdx = remainder.indexOf("/");
            if (slashIdx === -1) {
              // Direct child file
              files.push({ name: remainder, relativePath: rel, recordId: f.dataRecordId, contentHash: f.contentHash });
            } else {
              // Subfolder
              folders.add(remainder.slice(0, slashIdx));
            }
          }

          const folderList = Array.from(folders).sort().map(name => ({
            name,
            id: `watch:${watchId}/${subPath ? subPath + "/" : ""}${name}`,
            type: "folder" as const,
            itemCount: allFiles.filter(f => f.relativePath.startsWith((subPath ? subPath + "/" : "") + name + "/")).length,
          }));

          // Fetch record details for files
          const fileList = [];
          for (const f of files) {
            try {
              const record = await sdk.data.get(f.recordId as any);
              if (record) {
                fileList.push({
                  id: record.id,
                  name: f.name,
                  relativePath: f.relativePath,
                  mime_type: record.mimeType,
                  size_bytes: record.sizeBytes,
                  updated_at: new Date(record.updatedAt.wallTime).toISOString(),
                  created_at: new Date(record.createdAt.wallTime).toISOString(),
                });
              }
            } catch {}
          }

          json(res, { path: browsePath, watchId, folders: folderList, files: fileList });
          return;
        }

        // /Library — untracked records grouped by type
        if (browsePath === "/virtual:library") {
          const allData = await databaseAdapter.query({ limit: 100000 });
          const typeCounts = new Map<string, number>();

          for (const r of allData.records) {
            if (r.deletedAt) continue;
            const isWatched = watchManager.getAllStatuses().some(w => {
              return watchManager.getWatchFiles(w.id).some(f => f.dataRecordId === r.id);
            });
            if (!isWatched) {
              typeCounts.set(r.type, (typeCounts.get(r.type) || 0) + 1);
            }
          }

          const folders = Array.from(typeCounts.entries()).map(([type, count]) => ({
            name: type,
            id: `library-type:${type}`,
            type: "virtual" as const,
            itemCount: count,
          }));

          json(res, { path: browsePath, folders, files: [] });
          return;
        }

        // /library-type:<type> — flat list of untracked records of a type
        const libraryTypeMatch = browsePath.match(/^\/library-type:(.+)$/);
        if (libraryTypeMatch) {
          const recordType = libraryTypeMatch[1]!;
          const result = await databaseAdapter.query({
            filters: [{ field: "type" as const, operator: "eq" as const, value: recordType }],
            limit: 10000,
          });

          const files = result.records
            .filter(r => !r.deletedAt)
            .filter(r => {
              return !watchManager.getAllStatuses().some(w => {
                return watchManager.getWatchFiles(w.id).some(f => f.dataRecordId === r.id);
              });
            })
            .map(r => ({
              id: r.id,
              name: ((r as any).payload?.title || (r as any).payload?.name || (r as any).payload?.fileName || r.id) + (extensionForMime((r as any).mimeType) || ""),
              mime_type: (r as any).mimeType,
              size_bytes: (r as any).sizeBytes,
              updated_at: new Date(r.updatedAt.wallTime).toISOString(),
              created_at: new Date(r.createdAt.wallTime).toISOString(),
            }));

          json(res, { path: browsePath, folders: [], files });
          return;
        }

        res.writeHead(404);
        json(res, { error: "Browse path not found" });
        return;
      }

      // GET /data/types — list record types with counts
      if (path === "/data/types" && req.method === "GET") {
        const result = await databaseAdapter.query({ limit: 10000 });

        const typeCounts = new Map<string, { count: number; latest: number }>();
        for (const record of result.records) {
          if (record.deletedAt) continue;
          // When appId is present, restrict to types the app can access
          if (!appCanRead(localDb, appId!, record.type)) continue;
          const existing = typeCounts.get(record.type);
          const wallTime = record.updatedAt.wallTime;
          if (!existing) {
            typeCounts.set(record.type, { count: 1, latest: wallTime });
          } else {
            existing.count++;
            if (wallTime > existing.latest) existing.latest = wallTime;
          }
        }

        const types = Array.from(typeCounts.entries()).map(([type, info]) => ({
          record_type: type,
          count: info.count,
          latest_updated: new Date(info.latest).toISOString(),
        }));
        types.sort((a, b) => b.count - a.count);

        json(res, { types, total: result.records.filter(r => !r.deletedAt && appCanRead(localDb, appId!, r.type)).length });
        return;
      }

      // GET /data/records?type=xxx&limit=100&updated_after=<iso>
      if (path === "/data/records" && req.method === "GET") {
        const recordType = url.searchParams.get("type");
        const limit = parseInt(url.searchParams.get("limit") || "100", 10);
        const updatedAfter = url.searchParams.get("updated_after");

        const filters: { field: string; operator: "eq" | "gt"; value: string }[] = recordType
          ? [{ field: "type", operator: "eq", value: recordType }]
          : [];

        if (updatedAfter) {
          const ms = new Date(updatedAfter).getTime();
          if (!isNaN(ms)) {
            filters.push({
              field: "updatedAt",
              operator: "gt",
              value: serializeHLC({ wallTime: ms, counter: 0, nodeId: "" }),
            });
          }
        }

        const result = await databaseAdapter.query({
          filters,
          limit,
          sort: [{ field: "updatedAt", direction: "desc" as const }],
        });

        const records = await Promise.all(
          result.records
            .filter(r => !r.deletedAt && appCanRead(localDb, appId!, r.type))
            .map(async r => ({
              id: r.id,
              kind: r.kind,
              type: r.type,
              created_at: new Date(r.createdAt.wallTime).toISOString(),
              updated_at: new Date(r.updatedAt.wallTime).toISOString(),
              owner_id: r.ownerId,
              sync_status: r.syncStatus,
              version: r.version,
              content_hash: r.contentHash,
              object_storage_key: r.objectStorageKey,
              mime_type: r.mimeType,
              size_bytes: r.sizeBytes,
              original_filename: r.originalFilename,
              parent_id: r.parentId,
              path: r.objectStorageKey
                ? await localAdapter.resolvePath(r.objectStorageKey)
                : null,
            }))
        );

        json(res, { records });
        return;
      }

      // POST /data/records — create a record, optionally with a file
      // Body: JSON { type, payload, fileName?, contentType?, fileBase64?, filePath? }
      if (path === "/data/records" && req.method === "POST") {
        const body = await readBody(req);
        const { type, fileName, contentType, fileBase64, filePath, parentId } = JSON.parse(body);
        if (!type) {
          res.writeHead(400);
          json(res, { error: "type is required" });
          return;
        }
        if (!filePath && !fileBase64) {
          res.writeHead(400);
          json(res, {
            error: "filePath or fileBase64 is required — every record must be file-backed",
          });
          return;
        }
        if (!contentType) {
          res.writeHead(400);
          json(res, { error: "contentType is required" });
          return;
        }

        // Enforce write grant: the app's manifest must declare readwrite on this type.
        if (!appCanWrite(localDb, appId!, type)) {
          res.writeHead(403);
          json(res, {
            error: "AccessDenied",
            detail: `app "${appId}" has no readwrite grant on type "${type}"`,
          });
          return;
        }

        let record;
        let uploadedBuffer: Buffer | null = null;
        const baseInput = { type, ownerId: OWNER_ID, originAppId: appId!, parentId: parentId ?? null };
        if (filePath) {
          const resolvedName = fileName ?? (filePath as string).split("/").pop() ?? filePath;
          record = await sdk.data.putWithLocalFile(
            { ...baseInput, originalFilename: resolvedName },
            filePath,
            contentType,
          );
        } else {
          uploadedBuffer = Buffer.from(fileBase64, "base64");
          record = await sdk.data.putWithFile(
            { ...baseInput, originalFilename: fileName ?? null },
            uploadedBuffer,
            contentType,
          );
        }

        // Dual-write to remote S3 + Aurora DSQL when cloud config is present.
        // S3 write is awaited so the file is available for presigned URLs immediately
        // after the response is returned (avoids 404 on the first file-url request).
        if (remoteAdapter && record.objectStorageKey) {
          const fileData = uploadedBuffer
            ?? (await localAdapter.get(record.objectStorageKey).catch(() => null))?.data
            ?? null;
          if (fileData) {
            await remoteAdapter
              .put(record.objectStorageKey, fileData, { contentType: record.mimeType ?? undefined })
              .catch((err: Error) => console.error("S3 remote write failed (non-fatal):", err.message));
          }
        }
        if (remoteDatabaseAdapter) {
          remoteDatabaseAdapter
            .put(record)
            .catch((err: Error) => console.error("Aurora DSQL write failed (non-fatal):", err.message));
        }

        json(res, {
          record: {
            id: record.id,
            type: record.type,
            created_at: new Date(record.createdAt.wallTime).toISOString(),
            updated_at: new Date(record.updatedAt.wallTime).toISOString(),
            owner_id: record.ownerId,
            mime_type: record.mimeType,
            size_bytes: record.sizeBytes,
            object_storage_key: record.objectStorageKey,
            original_filename: record.originalFilename,
            parent_id: record.parentId,
            path: record.objectStorageKey
              ? await localAdapter.resolvePath(record.objectStorageKey)
              : null,
          },
        });
        return;
      }

      // POST /data/files?type=<typeId> — store raw binary bytes in
      // content-addressed local storage under shared/<typeId>/<shard>/<hash>.
      // Used by thin-client apps to upload bytes (e.g. downsized thumbnails)
      // before registering a metadata record that references the file. The
      // calling app must have `readwrite` access to the declared type.
      // Body: raw bytes. Content-Type header is the mime type.
      // Response: { key, contentHash, mimeType, sizeBytes }
      if (path === "/data/files" && req.method === "POST") {
        const typeId = url.searchParams.get("type");
        if (!typeId) {
          res.writeHead(400);
          json(res, { error: "type query param is required" });
          return;
        }
        const registered = appRegistryRow(localDb, appId!);
        const access = registered?.manifest.infraRequirements.sharedTypeAccess ?? [];
        const granted = access.some(
          (e) => e.access === "readwrite" && (e.typeId === typeId || e.typeId === "*"),
        );
        if (!granted) {
          res.writeHead(403);
          json(res, { error: `App does not have readwrite access to type "${typeId}"` });
          return;
        }
        const fileBuffer = await readBodyBuffer(req);
        if (fileBuffer.length === 0) {
          res.writeHead(400);
          json(res, { error: "Request body must not be empty" });
          return;
        }
        if (fileBuffer.length > 20_000_000) {
          res.writeHead(413);
          json(res, { error: "File too large (20 MB limit)" });
          return;
        }
        const mimeType = (req.headers["content-type"] ?? "application/octet-stream").split(";")[0]!.trim();
        const hex = createHash("sha256").update(fileBuffer).digest("hex");
        const key = dataRecordObjectKey(typeId, hex);
        await localAdapter.put(key, fileBuffer, { contentType: mimeType });
        json(res, { key, contentHash: hex, mimeType, sizeBytes: fileBuffer.length });
        return;
      }

      // ----- App-specific syncable data -----
      // All /app-data/... routes are implicitly scoped to the caller's appId
      // (resolved from the HMAC header by the auth middleware above), so the
      // URL never carries it. The handlers use the `appSpecific` view built
      // by createAppSpecificFactory which refuses ops on tables/files the
      // app didn't declare.
      if (path.startsWith("/app-data/")) {
        const view = appSpecificFactory({ subjectType: "app", subjectId: appId! });
        if (!view) {
          res.writeHead(404);
          json(res, {
            error: "App did not declare appSpecificSyncable in its manifest",
          });
          return;
        }

        const dbMatch = path.match(/^\/app-data\/db\/([^/]+)$/);
        if (dbMatch) {
          const table = decodeURIComponent(dbMatch[1]!);
          try {
            if (req.method === "POST") {
              const body = JSON.parse(await readBody(req)) as { row?: Record<string, unknown> };
              if (!body.row) {
                res.writeHead(400);
                json(res, { error: "row is required" });
                return;
              }
              await view.insertRow(table, body.row);
              json(res, { ok: true });
              return;
            }
            if (req.method === "PATCH") {
              const body = JSON.parse(await readBody(req)) as {
                where?: Record<string, unknown>;
                patch?: Record<string, unknown>;
              };
              if (!body.where || !body.patch) {
                res.writeHead(400);
                json(res, { error: "where and patch are required" });
                return;
              }
              const changes = await view.updateRow(table, body.where, body.patch);
              json(res, { changes });
              return;
            }
            if (req.method === "DELETE") {
              const body = JSON.parse(await readBody(req)) as { where?: Record<string, unknown> };
              if (!body.where) {
                res.writeHead(400);
                json(res, { error: "where is required" });
                return;
              }
              const changes = await view.deleteRow(table, body.where);
              json(res, { changes });
              return;
            }
            if (req.method === "GET") {
              const where: Record<string, unknown> = {};
              for (const [k, v] of url.searchParams) where[k] = v;
              const rows = await view.queryRows(table, Object.keys(where).length ? where : undefined);
              json(res, { rows });
              return;
            }
          } catch (err) {
            res.writeHead(400);
            json(res, { error: err instanceof Error ? err.message : String(err) });
            return;
          }
        }

        const fileMatch = path.match(/^\/app-data\/files\/(.+)$/);
        if (fileMatch) {
          const subKey = decodeURIComponent(fileMatch[1]!);
          try {
            if (req.method === "PUT") {
              const bytes = await readBodyBuffer(req);
              const mimeType = (req.headers["content-type"] ?? "application/octet-stream")
                .split(";")[0]!
                .trim();
              const result = await view.putFile(subKey, bytes, mimeType);
              json(res, result);
              return;
            }
            if (req.method === "GET") {
              const expiresIn = parseInt(url.searchParams.get("expiresIn") ?? "3600", 10);
              const fileUrl = await view.fileUrl(subKey, { expiresIn });
              if (!fileUrl) {
                res.writeHead(404);
                json(res, { error: "File not found" });
                return;
              }
              json(res, { url: fileUrl, expiresIn });
              return;
            }
            if (req.method === "DELETE") {
              await view.deleteFile(subKey);
              json(res, { ok: true });
              return;
            }
          } catch (err) {
            res.writeHead(400);
            json(res, { error: err instanceof Error ? err.message : String(err) });
            return;
          }
        }

        res.writeHead(404);
        json(res, { error: "Not found" });
        return;
      }

      // GET /data/records/:id/file-url — time-limited URL for file access
      const fileUrlMatch = path.match(/^\/data\/records\/([^/]+)\/file-url$/);
      if (fileUrlMatch && req.method === "GET") {
        const record = await sdk.data.get(fileUrlMatch[1]! as any);
        if (!record) {
          res.writeHead(404);
          json(res, { error: "Record not found" });
          return;
        }
        if (!record.objectStorageKey) {
          res.writeHead(404);
          json(res, { error: "Record has no attached file" });
          return;
        }
        const expiresIn = parseInt(url.searchParams.get("expiresIn") || "3600", 10);
        const mimeType = record.mimeType ?? "application/octet-stream";

        const localHit = await localAdapter.get(record.objectStorageKey).catch(() => null);
        if (localHit) {
          const token = createFileToken(record.objectStorageKey, mimeType, expiresIn);
          json(res, {
            url: `http://127.0.0.1:${PORT}/data/files/${token}`,
            source: "local",
            mimeType: record.mimeType,
            sizeBytes: record.sizeBytes,
            expiresIn,
          });
          return;
        }

        if (remoteAdapter?.getSignedUrl) {
          const fileUrl = await remoteAdapter.getSignedUrl(record.objectStorageKey, { expiresIn });
          json(res, { url: fileUrl, source: "remote", mimeType: record.mimeType, sizeBytes: record.sizeBytes, expiresIn });
          return;
        }

        res.writeHead(404);
        json(res, { error: "File not found locally and no remote storage configured" });
        return;
      }

      // GET /data/files/:token — serve file content, validating the signed token
      const fileServeMatch = path.match(/^\/data\/files\/([^/]+)$/);
      if (fileServeMatch && req.method === "GET") {
        const parsed = verifyFileToken(fileServeMatch[1]!);
        if (!parsed) {
          res.writeHead(403);
          json(res, { error: "Invalid or expired file token" });
          return;
        }
        const fileResult = await localAdapter.get(parsed.key);
        if (!fileResult) {
          res.writeHead(404);
          json(res, { error: "File not found" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": parsed.mimeType,
          "Content-Length": fileResult.size,
          "Cache-Control": "private, no-store",
        });
        res.end(Buffer.from(fileResult.data));
        return;
      }

      // POST /data/records/:id/metadata — write type-specific metadata for a record.
      // The app is responsible for extracting metadata values (e.g. EXIF from image
      // bytes); the server validates keys against the declared type schema and persists.
      // Requires readwrite access to the type.
      const metadataWriteMatch = path.match(/^\/data\/records\/([^/]+)\/metadata$/);
      if (metadataWriteMatch && req.method === "POST") {
        const recordId = metadataWriteMatch[1]!;
        const body = await readBody(req);
        const { typeId, metadata } = JSON.parse(body) as { typeId?: string; metadata?: Record<string, unknown> };
        if (!typeId) {
          res.writeHead(400);
          json(res, { error: "typeId is required" });
          return;
        }
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
          res.writeHead(400);
          json(res, { error: "metadata must be an object" });
          return;
        }
        if (!appCanWriteMetadata(localDb, appId!, typeId)) {
          res.writeHead(403);
          json(res, { error: "AccessDenied", detail: `app "${appId}" has no metadataWrite grant on type "${typeId}"` });
          return;
        }
        const coreType = CORE_TYPES.find((t) => t.id === typeId);
        if (!coreType) {
          res.writeHead(400);
          json(res, { error: `Unknown type "${typeId}" — only core types support metadata` });
          return;
        }
        const allowedColumns = new Set(coreType.metadataColumns.map((c) => c.name));
        const unknownKeys = Object.keys(metadata).filter((k) => !allowedColumns.has(k));
        if (unknownKeys.length > 0) {
          res.writeHead(400);
          json(res, { error: `Unknown metadata columns: ${unknownKeys.join(", ")}` });
          return;
        }
        await sdk.data.putMetadata(typeId, { recordId: recordId as any, ...metadata });
        json(res, { ok: true });
        return;
      }

      // GET /data/records/:id/metadata/:typeId — read type-specific metadata for a record.
      // Requires read or readwrite access to the type.
      const metadataReadMatch = path.match(/^\/data\/records\/([^/]+)\/metadata\/([^/]+)$/);
      if (metadataReadMatch && req.method === "GET") {
        const recordId = metadataReadMatch[1]!;
        const typeId = metadataReadMatch[2]!;
        if (!appCanRead(localDb, appId!, typeId)) {
          res.writeHead(403);
          json(res, { error: "AccessDenied", detail: `app "${appId}" has no read grant on type "${typeId}"` });
          return;
        }
        const metadata = await sdk.data.getMetadata(typeId, recordId as any);
        json(res, { metadata });
        return;
      }

      // GET /data/records/:id
      const recordMatch = path.match(/^\/data\/records\/([^/]+)$/);
      if (recordMatch && req.method === "GET") {
        const record = await sdk.data.get(recordMatch[1]! as any);
        if (!record) {
          res.writeHead(404);
          json(res, { error: "Record not found" });
          return;
        }
        json(res, {
          record: {
            id: record.id,
            kind: record.kind,
            type: record.type,
            created_at: new Date(record.createdAt.wallTime).toISOString(),
            updated_at: new Date(record.updatedAt.wallTime).toISOString(),
            owner_id: record.ownerId,
            sync_status: record.syncStatus,
            version: record.version,
            content_hash: record.contentHash,
            object_storage_key: record.objectStorageKey,
            mime_type: record.mimeType,
            size_bytes: record.sizeBytes,
            original_filename: record.originalFilename,
            parent_id: record.parentId,
            path: record.kind === "data" && record.objectStorageKey
              ? await localAdapter.resolvePath(record.objectStorageKey)
              : null,
          },
        });
        return;
      }

      // TODO: add POST /data/records/:id/report-failure endpoint — accepts { appId, reason }, stores
      // a flag against the record for admin review. Apps must not update the record type directly;
      // downgrading to @starkeep/unknown should be a human action via admin-web after reviewing flags.

      // ---------------------------------------------------------------
      // Watch endpoints
      // ---------------------------------------------------------------

      // POST /watches — register a new directory watch
      if (path === "/watches" && req.method === "POST") {
        const body = await readBody(req);
        const { directoryPath: rawDirectoryPath, recursive, includePatterns, excludePatterns } = JSON.parse(body);
        const directoryPath = typeof rawDirectoryPath === "string"
          ? rawDirectoryPath.replace(/^~/, homedir())
          : rawDirectoryPath;
        if (!directoryPath) {
          res.writeHead(400);
          json(res, { error: "directoryPath is required" });
          return;
        }
        // Validate directory exists
        try {
          const s = await fsStat(directoryPath);
          if (!s.isDirectory()) {
            res.writeHead(400);
            json(res, { error: "Path is not a directory" });
            return;
          }
        } catch {
          res.writeHead(400);
          json(res, { error: "Directory does not exist" });
          return;
        }
        // Check for duplicates
        const existing = await loadWatchConfigs();
        if (existing.some((c) => c.directoryPath === directoryPath)) {
          res.writeHead(409);
          json(res, { error: "A watch for this directory already exists." });
          return;
        }
        // Persist config locally and start watching
        const watchId = randomBytes(16).toString("hex");
        const watchConfig = {
          id: watchId,
          directoryPath,
          recursive: recursive ?? true,
          includePatterns,
          excludePatterns,
        };
        await saveWatchConfigs([...existing, watchConfig]);
        await watchManager.startWatch(watchConfig);
        const status = watchManager.getStatus(watchId);
        if (status?.state === "error") {
          await saveWatchConfigs(existing);
          res.writeHead(500);
          json(res, { error: status.error ?? "Failed to watch directory" });
          return;
        }
        json(res, { watch: status });
        return;
      }

      // GET /watches — list all watches
      if (path === "/watches" && req.method === "GET") {
        json(res, { watches: watchManager.getAllStatuses() });
        return;
      }

      // GET /watches/file-status?path=... — check if a file is watched/synced
      if (path === "/watches/file-status" && req.method === "GET") {
        const filePath = url.searchParams.get("path");
        if (!filePath) {
          res.writeHead(400);
          json(res, { error: "path query param required" });
          return;
        }
        json(res, watchManager.getFileStatus(filePath));
        return;
      }

      // GET /watches/directory-status?path=... — check if a directory is watched
      if (path === "/watches/directory-status" && req.method === "GET") {
        const dirPath = url.searchParams.get("path");
        if (!dirPath) {
          res.writeHead(400);
          json(res, { error: "path query param required" });
          return;
        }
        json(res, watchManager.getDirectoryStatus(dirPath));
        return;
      }

      // GET /watches/:id — single watch detail
      const watchDetailMatch = path.match(/^\/watches\/([^/]+)$/);
      if (watchDetailMatch && req.method === "GET") {
        const status = watchManager.getStatus(watchDetailMatch[1]!);
        if (!status) {
          res.writeHead(404);
          json(res, { error: "Watch not found" });
          return;
        }
        json(res, { watch: status });
        return;
      }

      // GET /watches/:id/files — list files in a watch
      const watchFilesMatch = path.match(/^\/watches\/([^/]+)\/files$/);
      if (watchFilesMatch && req.method === "GET") {
        const files = watchManager.getWatchFiles(watchFilesMatch[1]!);
        json(res, { files });
        return;
      }

      // DELETE /watches/:id — stop and remove a watch
      const watchDeleteMatch = path.match(/^\/watches\/([^/]+)$/);
      if (watchDeleteMatch && req.method === "DELETE") {
        const deleteId = watchDeleteMatch[1]!;
        await watchManager.stopWatch(deleteId);
        // Remove from local config (stopWatch already cleaned up watch_files tracking rows)
        const configs = await loadWatchConfigs();
        await saveWatchConfigs(configs.filter((c) => c.id !== deleteId));
        json(res, { ok: true });
        return;
      }

      // POST /data/records/:id/promote — promote an 'unknown' record to a typed record
      // Requires X-Starkeep-App-Id header from an app with canPromoteFromUnknown
      const promoteMatch = path.match(/^\/data\/records\/([^/]+)\/promote$/);
      if (promoteMatch && req.method === "POST") {
        const recordId = decodeURIComponent(promoteMatch[1]!);
        const body = JSON.parse(await readBody(req)) as { targetType?: string };
        if (!body.targetType) {
          res.writeHead(400);
          json(res, { error: "targetType is required" });
          return;
        }
        const registered = appRegistryRow(localDb, appId!);
        if (!registered?.manifest.infraRequirements.canPromoteFromUnknown) {
          res.writeHead(403);
          json(res, { error: "App does not have canPromoteFromUnknown permission" });
          return;
        }
        const record = await sdk.data.get(recordId as any);
        if (!record) {
          res.writeHead(404);
          json(res, { error: "Record not found" });
          return;
        }
        if (record.type !== "unknown") {
          res.writeHead(409);
          json(res, { error: "Only 'unknown' records can be promoted" });
          return;
        }
        // Promotion changes the type — that's an admin-level mutation rather
        // than a data-plane update, so we write to the underlying adapter
        // directly and bump version. No metadata changes; the file already
        // sits at its canonical objectStorageKey.
        const promoted = {
          ...record,
          type: body.targetType,
          version: record.version + 1,
          updatedAt: { wallTime: Date.now(), counter: 0, nodeId: NODE_ID },
        };
        await databaseAdapter.put(promoted);
        json(res, { record: { id: promoted.id, type: promoted.type, promoted_from: "unknown" } });
        return;
      }

      // POST /admin/apps/install — run the local installer for a manifest.
      // Body: the app's manifest.json. Returns { appId, hmacSecret } on success.
      // Called by admin-web on user-initiated install. Localhost-only, no HMAC
      // (the app has no secret yet — this is the bootstrapping primitive).
      if (path === "/admin/apps/install" && req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        try {
          const result = installLocal(localDb, body);
          json(res, { appId: result.appId, hmacSecret: result.hmacSecret });
        } catch (err) {
          if (err instanceof ManifestValidationError) {
            res.writeHead(400);
            json(res, { error: "ManifestValidationError", details: err.errors });
            return;
          }
          if (err instanceof LocalInstallError) {
            res.writeHead(500);
            json(res, { error: err.name, message: err.message });
            return;
          }
          throw err;
        }
        return;
      }

      // DELETE /admin/apps/:appId — run the local uninstaller for an app.
      const uninstallMatch = path.match(/^\/admin\/apps\/([^/]+)$/);
      if (uninstallMatch && req.method === "DELETE") {
        const targetAppId = decodeURIComponent(uninstallMatch[1]!);
        uninstallLocal(localDb, targetAppId, {
          deleteFilesPrefix: async (prefix) => {
            // Storage layout is the FS adapter's basePath/<key>. The syncable
            // prefix is its own directory tree under apps/<appId>/syncable/,
            // so removing it is just an rm -rf of that subtree.
            const target = join(objectsBasePath, prefix);
            await rm(target, { recursive: true, force: true });
          },
        });
        json(res, { ok: true, appId: targetAppId });
        return;
      }

      // GET /admin/apps — list registered apps. The HMAC secret is NOT
      // returned here; it is only exposed at install time so the caller can
      // hand it directly to the installed app.
      if (path === "/admin/apps" && req.method === "GET") {
        const apps = listAppRegistry(localDb).map((row) => ({
          appId: row.appId,
          name: row.name,
          version: row.version,
          tier: row.tier,
          status: row.status,
          installedAt: row.installedAt,
          sharedTypeAccess: row.manifest.infraRequirements.sharedTypeAccess,
          canIngestUnknown: row.manifest.infraRequirements.canIngestUnknown,
          canPromoteFromUnknown: row.manifest.infraRequirements.canPromoteFromUnknown,
        }));
        json(res, { apps });
        return;
      }

      // GET /events — SSE stream for real-time change notifications
      if (path === "/events" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });
        res.flushHeaders();
        res.write(": connected\n\n");
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }

      res.writeHead(404);
      json(res, { error: "Not found" });
    } catch (err) {
      console.error("Request error:", err);
      res.writeHead(500);
      json(res, { error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Starkeep data server listening on http://127.0.0.1:${PORT}`);
  });

  const shutdown = async () => {
    sseClients.forEach(c => c.end());
    server.close();
    if (pullTimer) clearTimeout(pullTimer);
    if (pushTimer) clearTimeout(pushTimer);
    await watchManager.shutdown();
    await sdk.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", async () => {
    // Reuse shutdown so Ctrl-C on a dev process drains cleanly.
    await shutdown();
  });
}

function extensionForMime(mime: string | null): string {
  if (!mime) return "";
  const map: Record<string, string> = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
    "image/heic": ".heic", "application/pdf": ".pdf", "text/plain": ".txt",
    "text/markdown": ".md", "application/json": ".json", "video/mp4": ".mp4",
  };
  return map[mime] ?? "";
}

// We cache the raw bytes (not the utf-8 string), so a handler called after the
// HMAC middleware has consumed the stream can still recover the original
// payload — readBody and readBodyBuffer both read from the same cache. The
// HMAC itself is computed over `cached.toString("utf8")` to match how callers
// (the photos proxy, the SDK clients) sign their requests.
type CachedReq = import("node:http").IncomingMessage & { _cachedBody?: Buffer };

async function readBodyBufferRaw(req: CachedReq): Promise<Buffer> {
  if (req._cachedBody !== undefined) return req._cachedBody;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      req._cachedBody = buf;
      resolve(buf);
    });
    req.on("error", reject);
  });
}

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  const buf = await readBodyBufferRaw(req as CachedReq);
  return buf.toString("utf8");
}

async function readBodyBuffer(req: import("node:http").IncomingMessage): Promise<Buffer> {
  return readBodyBufferRaw(req as CachedReq);
}

function json(res: import("node:http").ServerResponse, body: unknown) {
  if (!res.headersSent) res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/** Encode storage key + mime + expiry into a URL-safe signed token. */
function createFileToken(key: string, mimeType: string, expiresIn: number): string {
  const expires = Math.floor(Date.now() / 1000) + expiresIn;
  const payload = `${key}|${mimeType}|${expires}`;
  const sig = createHmac("sha256", TOKEN_SECRET).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${sig}`;
}

/** Verify and decode a file token. Returns null if invalid or expired. */
function verifyFileToken(token: string): { key: string; mimeType: string } | null {
  const dotIdx = token.indexOf(".");
  if (dotIdx === -1) return null;
  const payloadB64 = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  const payload = Buffer.from(payloadB64, "base64url").toString();
  const expected = createHmac("sha256", TOKEN_SECRET).update(payload).digest("base64url");
  if (sig !== expected) return null;
  const parts = payload.split("|");
  if (parts.length !== 3) return null;
  const expires = parseInt(parts[2]!, 10);
  if (Date.now() / 1000 > expires) return null;
  return { key: parts[0]!, mimeType: parts[1]! };
}

main().catch((err) => {
  console.error("Failed to start data server:", err);
  process.exit(1);
});
