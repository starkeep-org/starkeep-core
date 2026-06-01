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
} from "../../packages/admin-installer/src/local/registry.js";
import { LOCAL_WATCHER_APP_ID } from "../../packages/admin-installer/src/iam.js";
import { SqliteDatabaseAdapter } from "../../packages/storage-sqlite/src/adapter.js";
import {
  createSqliteAccessPolicyStore,
  createSqliteTypeRegistrationStore,
  SqliteAppSyncableNamespaceStore,
  SqliteAppSyncableApplier,
} from "../../packages/storage-sqlite/src/index.js";
import { createAppSpecificFactory } from "../../packages/shared-space-api/src/app-syncable/factory.js";
import { disabledSharingTokenStore } from "../../packages/access-control/src/stores.js";
import { FsObjectStorageAdapter } from "../../packages/storage-fs/src/adapter.js";
import { S3ObjectStorageAdapter } from "../../packages/storage-s3/src/adapter.js";
import type { ObjectStorageAdapter } from "../../packages/storage-adapter/src/object-storage/adapter.js";
import { createStarkeepSdk } from "../../packages/sdk/src/sdk.js";
import { createSqliteSyncStateStore, createChangeNotifier } from "../../packages/sync-engine/src/index.js";
import { createSyncSupervisor, DRIVE_APP_ID, type SyncSupervisor } from "./sync-supervisor.js";
import { getCategory, categoryOf, isCategoryId } from "../../packages/core/src/types/core-types.js";
import { createHLCClock, serializeHLC } from "../../packages/core/src/hlc/index.js";
import { dataRecordObjectKey } from "../../packages/core/src/storage/object-keys.js";
import { createStarkeepId } from "@starkeep/core";
import { join } from "node:path";
import { homedir } from "node:os";
import { stat as fsStat, readFile, writeFile, mkdir, unlink, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createFileWatchManager } from "./watcher.js";
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
const TOKEN_SECRET = randomBytes(32) as unknown as Uint8Array;

const STARKEEP_DIR = process.env.STARKEEP_DIR || join(homedir(), ".starkeep");
const PORT = parseInt(process.env.STARKEEP_PORT || "9820", 10);
// Intentionally not configurable. The request-auth model in this server treats
// the loopback bind as the boundary for administrative and host-level routes
// (see LOOPBACK_AUTHORIZED_PATTERNS below). Changing this address without
// also revisiting which routes skip app HMAC would silently de-authenticate
// the admin surface, the watch CRUD, /events, and /auth/*.
const LISTEN_HOST = "127.0.0.1";
const BIND_IS_LOOPBACK = LISTEN_HOST === "127.0.0.1" || LISTEN_HOST === "::1";
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

function grantsForApp(db: DatabaseSync, appId: string): AppGrantRow[] {
  // access_grants are keyed by extension (type_id = extension); one row per
  // declared extension. Drive (the User-Data-Owner) writes no rows — it is
  // granted all-access by app id below — so this is a plain lookup.
  return db
    .prepare(
      "SELECT type_id, access, metadata_write FROM shared_access_grants WHERE app_id = ?",
    )
    .all(appId) as unknown as AppGrantRow[];
}

// All-access local identities: Starkeep Drive (the User-Data-Owner) and the
// local watcher. Both operate on all shared data — every extension plus the
// Drive-only `other` catch-all — which cannot be represented as a finite set of
// extension grant rows, so they are authorized by app id (matching the cloud
// access-enforcer for Drive). `type` is the record's extension.
const ALL_ACCESS_APP_IDS = new Set<string>([DRIVE_APP_ID, LOCAL_WATCHER_APP_ID]);

function appCanRead(db: DatabaseSync, appId: string, type: string): boolean {
  if (ALL_ACCESS_APP_IDS.has(appId)) return true;
  return grantsForApp(db, appId).some((g) => g.type_id === type);
}

function appCanWrite(db: DatabaseSync, appId: string, type: string): boolean {
  if (ALL_ACCESS_APP_IDS.has(appId)) return true;
  return grantsForApp(db, appId).some((g) => g.type_id === type && g.access === "readwrite");
}

// Category-level access. Object-storage keys (`shared/<category>/…`) and the
// per-category metadata tables are category-namespaced (so is the IAM ceiling),
// so they authorize against the categories the app's extension grants map to —
// a category is accessible when at least one granted extension maps to it.
function appCanReadCategory(db: DatabaseSync, appId: string, category: string): boolean {
  if (ALL_ACCESS_APP_IDS.has(appId)) return true;
  return grantsForApp(db, appId).some((g) => categoryOf(g.type_id) === category);
}

function appCanWriteCategory(db: DatabaseSync, appId: string, category: string): boolean {
  if (ALL_ACCESS_APP_IDS.has(appId)) return true;
  return grantsForApp(db, appId).some(
    (g) => categoryOf(g.type_id) === category && g.access === "readwrite",
  );
}

function appCanWriteMetadataCategory(db: DatabaseSync, appId: string, category: string): boolean {
  if (ALL_ACCESS_APP_IDS.has(appId)) return true;
  return grantsForApp(db, appId).some(
    (g) => categoryOf(g.type_id) === category && g.metadata_write === 1,
  );
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
  return timingSafeEqual(sigBuf as unknown as Uint8Array, expBuf as unknown as Uint8Array);
}

const STARKEEP_CONFIG_PATH = join(STARKEEP_DIR, "config.json");

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

// Detects the unique-violation from the (owner_id, original_filename,
// content_hash) index added in storage-sqlite bootstrap and mirrored in DSQL.
// SQLite surfaces "UNIQUE constraint failed: ..." and Postgres surfaces
// SQLSTATE 23505; matching the index name covers both without a driver dep.
function isDuplicateFileError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("uq_shared_records_owner_filename_hash") ||
    message.includes("uq_records_owner_filename_hash")
  );
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
    console.warn(`No config found at ${STARKEEP_CONFIG_PATH} — cloud features disabled`);
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

async function main() {
  const databaseAdapter = new SqliteDatabaseAdapter({
    path: join(STARKEEP_DIR, "data.db"),
  });

  // Local FS is always available — acts as a cache when S3 is configured
  const objectsBasePath = join(STARKEEP_DIR, "objects");
  const localAdapter = new FsObjectStorageAdapter({
    basePath: objectsBasePath,
  });

  // Load cloud config from ~/.starkeep/config.json
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

  /**
   * Local JWT exp check (no network). Cognito id tokens are standard JWTs
   * with an `exp` claim in seconds. We treat a token within 5s of expiry as
   * unusable so the supervisor doesn't start an exchange that will 401
   * mid-flight.
   */
  function idTokenIsLive(): boolean {
    if (!currentIdToken) return false;
    const parts = currentIdToken.split(".");
    if (parts.length !== 3) return false;
    try {
      const payload = JSON.parse(
        Buffer.from(parts[1], "base64url").toString("utf8"),
      ) as { exp?: number };
      return typeof payload.exp === "number" && payload.exp * 1000 > Date.now() + 5_000;
    } catch {
      return false;
    }
  }

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
        startOrKickSupervisor();
      },
    );
  }

  // S3: use ~/.starkeep/config.json values when available, otherwise fall back to env vars
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

  // App identities are stored in shared_app_registry; populated by the
  // installer (POST /admin/apps/install). No startup-time auto-discovery —
  // apps appear only after going through install.

  const clock = createHLCClock({ nodeId: NODE_ID, wallClockFunction: Date.now });

  // Pre-init so we can hand the raw SQLite handle to the sync state store,
  // which shares the records DB file.
  await databaseAdapter.init();

  // The state store is used by the SDK for HLC clock state (global, one clock
  // per node); per-app watermarks are owned by the supervisor's per-app
  // adapters around it.
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

  // Hoisted so the app-specific factory and the SDK share one notifier:
  // app-specific writes (via the factory) emit `local-change-recorded` tagged
  // with the writing app's id, and the supervisor subscribes once to route
  // nudges to the owning per-app engine. The SDK's own shared-record writes
  // emit on the same notifier without an originAppId (Drive owns them).
  const changeNotifier = createChangeNotifier();

  const appSpecificFactory = createAppSpecificFactory({
    namespace: namespaceStore,
    applier: appApplier,
    fileStorage: localAdapter,
    buildFileUrl: (key, mimeType, expiresIn) => {
      const token = createFileToken(key, mimeType, expiresIn);
      return `http://127.0.0.1:${PORT}/data/files/${token}`;
    },
    clock,
    changeNotifier,
  });

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
    syncStateStore,
    changeNotifier,
    getAppSpecific: appSpecificFactory,
  });

  const sseClients = new Set<import("node:http").ServerResponse>();
  setInterval(() => {
    for (const client of sseClients) client.write(": ping\n\n");
  }, 25_000);

  // SSE fan-out: every event on the SDK's unified notifier (writes from
  // local-data-server, plus pull/conflict events forwarded by the supervisor
  // below) emits a payload-less kick to connected SSE clients. The kick tells
  // clients "something changed, go re-fetch through your normal data plane" —
  // we deliberately do not put record ids or event types on the wire, because
  // /events is loopback-authorized with no per-app filtering and the data
  // plane (which is HMAC-authenticated and grant-checked) is the only place
  // record-shaped information should leave this process.
  sdk.changeNotifier.subscribe((event) => {
    console.log(`[sync] ${event.eventType} records=${event.recordIds.length}`);
    for (const client of sseClients) client.write(`data: \n\n`);
  });

  // Sync supervisor: owns N SyncEngine instances, one per installed app.
  // Without a cloud URL or sync state store there's no sync — leave it null.
  let supervisor: SyncSupervisor | null = null;
  if (CLOUD_URL && syncStateStore) {
    supervisor = createSyncSupervisor({
      sdk,
      databaseAdapter,
      localObjectStorage: localAdapter,
      localDb: databaseAdapter.getRawDatabase(),
      cloudUrl: CLOUD_URL,
      getAuthHeader: () => (currentIdToken ? `Bearer ${currentIdToken}` : undefined),
      listInstalledApps: () =>
        listAppRegistry(localDb).map((row) => ({
          appId: row.appId,
          status: row.status,
        })),
      namespaceStore,
      appApplier,
      underlyingSyncStateStore: syncStateStore,
      exchangeIntervalMs: PULL_INTERVAL_MS,
      nudgeDebounceMs: PUSH_DEBOUNCE_MS,
    });
  }

  // Built-in local file-watcher identity. All records originated by LDS
  // built-in features (notably the file watcher) are stamped with this appId
  // as their immutable origin_app_id, both in the local change log and on the
  // wire. Under Shape A this is a *local-only* identity: its records are shared
  // records that sync to the cloud via the Starkeep Drive channel under Drive's
  // role — there is no dedicated cloud write-role for it. Its grants flow
  // through the same local access-control path as any other app. No user
  // consent — it's part of the LDS itself.
  const localWatcherManifest = {
    id: LOCAL_WATCHER_APP_ID,
    name: "Local Watcher",
    version: "1.0.0",
    tier: "official" as const,
    infraRequirements: {
      // The watcher ingests via the in-process SDK, not the HTTP access path,
      // so it needs no grant rows. It is additionally granted all-access by app
      // id in the access functions (it stamps arbitrary files, including the
      // Drive-only `other` category). fileAccessAll is reserved to Drive, so it
      // is not set here.
      fileAccess: [],
    },
  };
  const { appId: watcherAppId } = installLocal(localDb, localWatcherManifest);

  // Built-in Starkeep Drive identity (the User-Data-Owner). Installing it
  // locally writes Drive's hmac_secret into shared_app_registry. Drive declares
  // `fileAccessAll` (the only app permitted to) rather than enumerated
  // extensions — it cannot enumerate unmapped/`other` extensions — so it writes
  // no access_grants rows; the access functions grant it all-access by app id.
  // Thus:
  //   - the always-on Drive sync engine (Shape A) is the legitimate all-access
  //     identity that scans all shared records for the single Drive channel;
  //   - the Drive UI authenticates as `starkeep-drive` over HMAC and reads all
  //     shared data through the same appCanRead path as any app — no bypass.
  // No cloud credentials live here; the cloud-side write identity for shared
  // data is always Drive, assumed inside cloud-data-server based on the channel
  // path.
  const driveManifest = {
    id: DRIVE_APP_ID,
    name: "Starkeep Drive",
    version: "0.1.0",
    tier: "official" as const,
    infraRequirements: {
      fileAccess: [],
      fileAccessAll: true,
    },
  };
  installLocal(localDb, driveManifest);

  // Now that the watcher, Drive, and any other apps are in the registry, start
  // sync loops (the always-on Drive channel + per-app channels). New installs
  // via /admin/apps/install call `supervisor.rescan()` to pick up the new app.
  //
  // Gating on a live id token avoids the failure mode where startup ticks fire
  // before the credential-refresh callback has minted a fresh token: each
  // would 401 and bump the per-engine backoff up to the 5-min cap, and nothing
  // would wake them once auth finally lands. If we have no live token at boot
  // we defer start to whichever event delivers one first (refresh callback,
  // /auth/login, /auth/tokens) via startOrKickSupervisor().
  let supervisorStarted = false;
  function startOrKickSupervisor(): void {
    if (!supervisor) return;
    if (!idTokenIsLive()) return;
    if (!supervisorStarted) {
      supervisor.start();
      supervisorStarted = true;
      return;
    }
    supervisor.kick();
  }
  startOrKickSupervisor();

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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Starkeep-App-Id, X-Starkeep-App-Sig");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://localhost:${PORT}`);
    const path = url.pathname;

    // Per-request app identity. Required for every route that touches the
    // per-app data plane. Two narrow categories of route are gated differently:
    //   - LOOPBACK_AUTHORIZED_PATTERNS: administrative / host-level routes,
    //     gated by the 127.0.0.1 bind rather than by app HMAC. Adding a new
    //     route here is a deliberate assertion that the route is safe to
    //     expose to any loopback caller (configures the server, brokers the
    //     user's own cloud session, manages watches, or is already tracked
    //     in the functional review as a known leak). If LISTEN_HOST is ever
    //     changed away from loopback these routes fail closed.
    //   - TOKEN_AUTHORIZED_PATTERNS: the signed token in the URL is the auth,
    //     and the URL is meant to be embeddable (e.g. in <img src>).
    // Every other route requires X-Starkeep-App-Id and a valid HMAC body sig.
    const appId = req.headers["x-starkeep-app-id"] as string | undefined;
    const appSig = req.headers["x-starkeep-app-sig"] as string | undefined;

    const LOOPBACK_AUTHORIZED_PATTERNS = [
      /^\/health$/,
      /^\/config$/,
      /^\/auth(\/|$)/,
      /^\/admin(\/|$)/,
      /^\/watches(\/|$)/,
      /^\/events$/,
    ];
    const TOKEN_AUTHORIZED_PATTERNS = [
      /^\/data\/files\/upload\/[^/]+$/,
      /^\/data\/files\/[^/]+$/,
    ];

    const isLoopbackAuthorized = LOOPBACK_AUTHORIZED_PATTERNS.some((re) => re.test(path));
    const isTokenAuthorized = TOKEN_AUTHORIZED_PATTERNS.some((re) => re.test(path));

    // Fail closed: if the server is not bound to loopback, every route that
    // relied on the loopback boundary for its authorization must refuse.
    if (isLoopbackAuthorized && !BIND_IS_LOOPBACK) {
      res.writeHead(403);
      json(res, { error: "Loopback-authorized route disabled: server is not bound to loopback" });
      return;
    }

    const requiresAppAuth = !isLoopbackAuthorized && !isTokenAuthorized;

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
          json(res, { error: "No ~/.starkeep/config.json found — cannot authenticate" });
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
            startOrKickSupervisor();
          },
        );

        startOrKickSupervisor();
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
            startOrKickSupervisor();
          },
        );
        startOrKickSupervisor();
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

      // Sync observability + manual trigger — backed by the supervisor.
      if (path === "/sync/status" && req.method === "GET") {
        if (!supervisor) {
          json(res, {
            enabled: false,
            syncPaused: false,
            cloudUrl: CLOUD_URL ?? null,
            perApp: [],
            lastError: null,
            lastExchangeAt: null,
            backoffMs: PULL_INTERVAL_MS,
          });
          return;
        }
        json(res, supervisor.status());
        return;
      }

      if (path === "/sync/pause" && req.method === "POST") {
        if (!supervisor) {
          res.writeHead(400);
          json(res, { error: "sync not configured" });
          return;
        }
        supervisor.pause();
        json(res, { ok: true });
        return;
      }

      if (path === "/sync/resume" && req.method === "POST") {
        if (!supervisor) {
          res.writeHead(400);
          json(res, { error: "sync not configured" });
          return;
        }
        supervisor.resume().catch((err: Error) =>
          console.error("resume failed:", err),
        );
        json(res, { ok: true });
        return;
      }

      if (path === "/sync/now" && req.method === "POST") {
        if (!supervisor) {
          res.writeHead(400);
          json(res, { error: "sync not configured" });
          return;
        }
        const result = await supervisor.exchangeAll();
        json(res, result);
        return;
      }

      // GET /cloud/data/types and /cloud/data/records — read-only proxy to the
      // cloud-data-server, signed with the local-data-server's live Cognito id
      // token. The calling app (e.g. starkeep-drive) authenticates to *us* with
      // its HMAC as usual; we then re-auth to the cloud as the signed-in user.
      // The cloud enforces the same per-app grants for /apps/{appId}/data/*, so
      // this exposes no data the app couldn't already sync. Lets the Drive UI
      // show the cloud-side view (what actually pushed) next to the local view.
      if (path === "/cloud/data/types" || path === "/cloud/data/records") {
        if (req.method !== "GET") {
          res.writeHead(405);
          json(res, { error: "Method not allowed" });
          return;
        }
        if (!CLOUD_URL) {
          res.writeHead(503);
          json(res, { error: "Cloud is not configured (no apiGatewayUrl / STARKEEP_CLOUD_URL)" });
          return;
        }
        if (!currentIdToken) {
          res.writeHead(503);
          json(res, { error: "Not signed in to the cloud (no id token)" });
          return;
        }
        const subPath = path.slice("/cloud".length); // "/data/types" | "/data/records"
        const cloudUrl = `${CLOUD_URL.replace(/\/+$/, "")}/apps/${encodeURIComponent(appId!)}${subPath}${url.search}`;
        try {
          const cloudRes = await fetch(cloudUrl, {
            headers: { Authorization: `Bearer ${currentIdToken}` },
          });
          const text = await cloudRes.text();
          res.writeHead(cloudRes.status, {
            "Content-Type": cloudRes.headers.get("content-type") ?? "application/json",
          });
          res.end(text);
        } catch (err) {
          res.writeHead(502);
          json(res, { error: `cloud request failed: ${err instanceof Error ? err.message : String(err)}` });
        }
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
              category: categoryOf(r.type),
              // Immutable provenance: which app created the record. Surfaced so
              // the Drive UI can show "this came from photos" even when photos
              // isn't cloud-installed.
              origin_app_id: r.originAppId,
              created_at: new Date(r.createdAt.wallTime).toISOString(),
              updated_at: new Date(r.updatedAt.wallTime).toISOString(),
              owner_id: r.ownerId,
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

      // POST /data/records — create a record from a file.
      // Two body shapes (in preference order):
      //   key-ref:  { type, contentType, contentHash, sizeBytes, fileName?, parentId? }
      //             Bytes already PUT via the presigned upload URL. Server
      //             verifies the blob is at shared/<type>/<shard>/<hash>.
      //             The path that scales to large files.
      //   filePath: { type, contentType, filePath, fileName?, parentId? }
      //             Bytes live on local disk; SDK ingests by path. Same-machine
      //             only — legit optimization over the network round trip.
      if (path === "/data/records" && req.method === "POST") {
        const body = await readBody(req);
        const {
          type,
          fileName,
          contentType,
          filePath,
          contentHash,
          sizeBytes,
          parentId,
        } = JSON.parse(body);
        if (!type) {
          res.writeHead(400);
          json(res, { error: "type is required" });
          return;
        }
        if (!filePath && !contentHash) {
          res.writeHead(400);
          json(res, {
            error:
              "contentHash (key-ref) or filePath is required — PUT bytes via a presigned URL first, then register by content-addressed key",
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

        // Render a record into the API response shape. Used for both the
        // freshly-created and dedup-existing paths.
        const renderRecord = async (r: {
          id: string;
          type: string;
          createdAt: { wallTime: number };
          updatedAt: { wallTime: number };
          ownerId: string;
          mimeType: string;
          sizeBytes: number;
          objectStorageKey: string | null;
          originalFilename: string | null;
          parentId: string | null;
        }) => ({
          id: r.id,
          type: r.type,
          created_at: new Date(r.createdAt.wallTime).toISOString(),
          updated_at: new Date(r.updatedAt.wallTime).toISOString(),
          owner_id: r.ownerId,
          mime_type: r.mimeType,
          size_bytes: r.sizeBytes,
          object_storage_key: r.objectStorageKey,
          original_filename: r.originalFilename,
          parent_id: r.parentId,
          path: r.objectStorageKey ? await localAdapter.resolvePath(r.objectStorageKey) : null,
        });

        // Owner-scoped duplicate check: (owner, filename, content) is unique
        // among live records. Same bytes under the same filename → return the
        // existing record with deduped:true, matching the response shape this
        // endpoint already uses. Enforced at the DB layer too — this pre-check
        // turns the would-be unique-violation into an idempotent success.
        const dedupFilename = fileName ?? null;
        if (contentHash && dedupFilename && /^[a-f0-9]{64}$/.test(contentHash)) {
          const dup = await databaseAdapter.query({
            filters: [
              { field: "ownerId", operator: "eq", value: OWNER_ID },
              { field: "originalFilename", operator: "eq", value: dedupFilename },
              { field: "contentHash", operator: "eq", value: contentHash },
              { field: "deletedAt", operator: "isNull" },
            ],
            limit: 1,
          });
          const existing = dup.records[0];
          if (existing) {
            json(res, { record: await renderRecord(existing), deduped: true });
            return;
          }
        }

        let record;
        const baseInput = { type, ownerId: OWNER_ID, originAppId: appId!, parentId: parentId ?? null };
        if (contentHash) {
          if (!/^[a-f0-9]{64}$/.test(contentHash)) {
            res.writeHead(400);
            json(res, { error: "contentHash must be a 64-char lowercase hex sha256" });
            return;
          }
          if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
            res.writeHead(400);
            json(res, { error: "sizeBytes is required and must be a non-negative number" });
            return;
          }
          const expectedKey = dataRecordObjectKey(type, contentHash);
          const exists = await localAdapter.has(expectedKey);
          if (!exists) {
            res.writeHead(409);
            json(res, {
              error:
                "Blob not found at the content-addressed key. PUT it via a presigned URL first.",
            });
            return;
          }
          // Dedup derived children (thumbnails) by (parentId, contentHash).
          // A byte-identical child of the same parent is a duplicate — e.g.
          // two concurrent /api/resize calls for one original. We key on
          // contentHash too so distinct crops of the same source (same parent,
          // different bytes) are NOT collapsed. Idempotent: return the
          // existing record instead of registering a second row.
          if (parentId) {
            const dup = await databaseAdapter.query({
              filters: [
                { field: "parentId", operator: "eq", value: parentId },
                { field: "contentHash", operator: "eq", value: contentHash },
                { field: "deletedAt", operator: "isNull" },
              ],
              limit: 1,
            });
            const existing = dup.records[0];
            if (existing) {
              json(res, { record: await renderRecord(existing), deduped: true });
              return;
            }
          }
          try {
            record = await sdk.data.putWithExistingBlob(
              { ...baseInput, originalFilename: fileName ?? null },
              { contentHash, objectStorageKey: expectedKey, sizeBytes, mimeType: contentType },
            );
          } catch (err) {
            if (isDuplicateFileError(err)) {
              res.writeHead(409);
              json(res, { error: "Duplicate file" });
              return;
            }
            throw err;
          }
        } else {
          const resolvedName = fileName ?? (filePath as string).split("/").pop() ?? filePath;
          try {
            record = await sdk.data.putWithLocalFile(
              { ...baseInput, originalFilename: resolvedName },
              filePath,
              contentType,
            );
          } catch (err) {
            if (isDuplicateFileError(err)) {
              res.writeHead(409);
              json(res, { error: "Duplicate file" });
              return;
            }
            throw err;
          }
        }

        // Cloud propagation happens via the sync engine, not from here. The
        // engine pushes record metadata through the per-app sync transport and
        // then uploads the blob via HttpObjectStorageAdapter against
        // /apps/<originAppId>/files, where the cloud-data-server assumes the
        // origin app's role to PUT into S3. That's the only path that
        // attributes the byte to its originating app, per
        // roles-and-permissions.md.

        json(res, { record: await renderRecord(record) });
        return;
      }

      // POST /files/presign — issue a short-lived URL the caller can PUT to.
      // Mirrors the cloud-data-server API so a single client code path works
      // against either backend. Body: { key, contentType? }. Response: { url }.
      //
      // Auth: requires the caller's app HMAC (same as any /data/ endpoint).
      // The issued URL itself is bearer-style: anyone holding it can PUT to
      // that exact key until it expires.
      if (path === "/files/presign" && req.method === "POST") {
        const body = JSON.parse(await readBody(req)) as {
          key?: string;
          contentType?: string;
          expiresIn?: number;
        };
        if (!body.key) {
          res.writeHead(400);
          json(res, { error: "key is required" });
          return;
        }
        // Extract the category from the canonical shared/<category>/<shard>/<hash>
        // key and enforce that this app can write that category. Object keys are
        // category-namespaced (see object-keys.ts), so this is a category check.
        const sharedMatch = body.key.match(/^shared\/([^/]+)\//);
        if (!sharedMatch) {
          res.writeHead(400);
          json(res, {
            error: "presign currently only supports shared/<category>/... keys",
          });
          return;
        }
        const category = sharedMatch[1]!;
        if (!appCanWriteCategory(localDb, appId!, category)) {
          res.writeHead(403);
          json(res, {
            error: "AccessDenied",
            detail: `app "${appId}" has no readwrite grant on category "${category}"`,
          });
          return;
        }
        const mimeType = body.contentType ?? "application/octet-stream";
        const expiresIn = body.expiresIn ?? 3600;
        const token = createUploadToken(body.key, mimeType, expiresIn);
        json(res, {
          url: `http://127.0.0.1:${PORT}/data/files/upload/${token}`,
        });
        return;
      }

      // PUT /data/files/upload/:token — accept raw bytes for the key encoded
      // in the upload token. The token is the authorization (issued by the
      // presign endpoint above), so the request itself doesn't need an app
      // HMAC — see APP_AUTH_EXEMPT_PATTERNS.
      const uploadMatch = path.match(/^\/data\/files\/upload\/([^/]+)$/);
      if (uploadMatch && req.method === "PUT") {
        const parsed = verifyUploadToken(uploadMatch[1]!);
        if (!parsed) {
          res.writeHead(403);
          json(res, { error: "Invalid or expired upload token" });
          return;
        }
        const fileBuffer = await readBodyBuffer(req);
        if (fileBuffer.length === 0) {
          res.writeHead(400);
          json(res, { error: "Request body must not be empty" });
          return;
        }
        // The token's key is content-addressed (shared/<typeId>/<shard>/<hash>).
        // Verify the body actually hashes to the expected key, otherwise the
        // caller is trying to write mismatched bytes under a fixed name.
        const expectedHash = parsed.key.split("/").pop();
        const actualHash = createHash("sha256")
          .update(fileBuffer as unknown as Uint8Array)
          .digest("hex");
        if (expectedHash !== actualHash) {
          res.writeHead(400);
          json(res, {
            error: "Upload body hash does not match the key",
            expected: expectedHash,
            actual: actualHash,
          });
          return;
        }
        await localAdapter.put(parsed.key, fileBuffer, { contentType: parsed.mimeType });
        // Cloud propagation is handled by the sync engine's file-transfer pass
        // (sync-engine.ts runFileTransferPass), which uploads the blob via the
        // per-app sync transport so the byte is attributed to the originating
        // app's role on the cloud side.
        res.writeHead(204);
        res.end();
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
        // Bytes land at shared/<category>/…, so authorize the derived category
        // (the type param is normally an extension).
        const fileCategory = isCategoryId(typeId) ? typeId : categoryOf(typeId);
        if (!appCanWriteCategory(localDb, appId!, fileCategory)) {
          res.writeHead(403);
          json(res, { error: `App does not have readwrite access to category "${fileCategory}"` });
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
        const hex = createHash("sha256").update(fileBuffer as unknown as Uint8Array).digest("hex");
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
              const result = await view.putFile(subKey, bytes as unknown as Uint8Array, mimeType);
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
        const record = await sdk.data.get(createStarkeepId(fileUrlMatch[1]!));
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

      // POST /data/records/:id/metadata — write metadata for a record.
      // The app is responsible for extracting metadata values (e.g. EXIF from
      // image bytes); the server validates keys against the per-category schema
      // and persists. `typeId` is the record's extension (or a category id);
      // the metadata table is the derived category's. Requires metadataWrite
      // access to the extension.
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
        const category = isCategoryId(typeId) ? typeId : categoryOf(typeId);
        if (!appCanWriteMetadataCategory(localDb, appId!, category)) {
          res.writeHead(403);
          json(res, { error: "AccessDenied", detail: `app "${appId}" has no metadataWrite grant on category "${category}"` });
          return;
        }
        if (category === "other") {
          res.writeHead(400);
          json(res, { error: `Category "other" has no metadata table — only mapped categories support metadata` });
          return;
        }
        const categoryDef = getCategory(category)!;
        const allowedColumns = new Set(categoryDef.metadataColumns.map((c) => c.name));
        const unknownKeys = Object.keys(metadata).filter((k) => !allowedColumns.has(k));
        if (unknownKeys.length > 0) {
          res.writeHead(400);
          json(res, { error: `Unknown metadata columns: ${unknownKeys.join(", ")}` });
          return;
        }
        await sdk.data.putMetadata(category, { recordId: createStarkeepId(recordId), ...metadata });
        json(res, { ok: true });
        return;
      }

      // GET /data/records/:id/metadata/:typeId — read type-specific metadata for a record.
      // Requires read or readwrite access to the type.
      const metadataReadMatch = path.match(/^\/data\/records\/([^/]+)\/metadata\/([^/]+)$/);
      if (metadataReadMatch && req.method === "GET") {
        const recordId = metadataReadMatch[1]!;
        const typeId = metadataReadMatch[2]!;
        const category = isCategoryId(typeId) ? typeId : categoryOf(typeId);
        if (!appCanReadCategory(localDb, appId!, category)) {
          res.writeHead(403);
          json(res, { error: "AccessDenied", detail: `app "${appId}" has no read grant on category "${category}"` });
          return;
        }
        if (category === "other") {
          // `other` has no metadata table; nothing to read.
          json(res, { metadata: null });
          return;
        }
        const metadata = await sdk.data.getMetadata(category, createStarkeepId(recordId));
        json(res, { metadata });
        return;
      }

      // GET /data/records/:id
      const recordMatch = path.match(/^\/data\/records\/([^/]+)$/);
      if (recordMatch && req.method === "GET") {
        const record = await sdk.data.get(createStarkeepId(recordMatch[1]!));
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
            category: categoryOf(record.type),
            created_at: new Date(record.createdAt.wallTime).toISOString(),
            updated_at: new Date(record.updatedAt.wallTime).toISOString(),
            owner_id: record.ownerId,
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

      // POST /admin/apps/install — run the local installer for a manifest.
      // Body: the app's manifest.json. Returns { appId, hmacSecret } on success.
      // Called by admin-web on user-initiated install. Localhost-only, no HMAC
      // (the app has no secret yet — this is the bootstrapping primitive).
      if (path === "/admin/apps/install" && req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        try {
          const result = installLocal(localDb, body);
          // Bring up a sync loop for the freshly-installed app.
          supervisor?.rescan();
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
        // Tear down the per-app sync loop.
        supervisor?.rescan();
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
          fileAccess: row.manifest.infraRequirements.fileAccess,
          fileAccessAll: row.manifest.infraRequirements.fileAccessAll,
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

  server.listen(PORT, LISTEN_HOST, () => {
    console.log(`Starkeep data server listening on http://${LISTEN_HOST}:${PORT}`);
  });

  const shutdown = async () => {
    sseClients.forEach(c => c.end());
    server.close();
    if (supervisor) await supervisor.stop();
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
      const buf = Buffer.concat(chunks as unknown as Uint8Array[]);
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
  const payload = `r|${key}|${mimeType}|${expires}`;
  const sig = createHmac("sha256", TOKEN_SECRET).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${sig}`;
}

/** Verify and decode a file token. Returns null if invalid or expired. */
function verifyFileToken(token: string): { key: string; mimeType: string } | null {
  const parsed = decodeSignedToken(token);
  if (!parsed) return null;
  if (parsed.scope !== "r") return null;
  return { key: parsed.key, mimeType: parsed.mimeType };
}

/** Same shape as createFileToken but scoped to a single PUT upload. */
function createUploadToken(key: string, mimeType: string, expiresIn: number): string {
  const expires = Math.floor(Date.now() / 1000) + expiresIn;
  const payload = `w|${key}|${mimeType}|${expires}`;
  const sig = createHmac("sha256", TOKEN_SECRET).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${sig}`;
}

function verifyUploadToken(token: string): { key: string; mimeType: string } | null {
  const parsed = decodeSignedToken(token);
  if (!parsed) return null;
  if (parsed.scope !== "w") return null;
  return { key: parsed.key, mimeType: parsed.mimeType };
}

function decodeSignedToken(
  token: string,
): { scope: string; key: string; mimeType: string } | null {
  const dotIdx = token.indexOf(".");
  if (dotIdx === -1) return null;
  const payloadB64 = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  const payload = Buffer.from(payloadB64, "base64url").toString();
  const expected = createHmac("sha256", TOKEN_SECRET).update(payload).digest("base64url");
  if (sig !== expected) return null;
  const parts = payload.split("|");
  // Legacy read-only tokens were `${key}|${mimeType}|${expires}` (3 parts);
  // new tokens carry a scope prefix making 4. Accept both for the read path.
  if (parts.length === 3) {
    const expires = parseInt(parts[2]!, 10);
    if (Date.now() / 1000 > expires) return null;
    return { scope: "r", key: parts[0]!, mimeType: parts[1]! };
  }
  if (parts.length !== 4) return null;
  const expires = parseInt(parts[3]!, 10);
  if (Date.now() / 1000 > expires) return null;
  return { scope: parts[0]!, key: parts[1]!, mimeType: parts[2]! };
}

main().catch((err) => {
  console.error("Failed to start data server:", err);
  process.exit(1);
});
