/**
 * Local data server for the Starkeep admin desktop app.
 * Exposes the SDK over HTTP with owner-level access so the admin
 * browses data through proper access control, not by reading the DB directly.
 */

// First import: load repo-root .env / .env.local so STARKEEP_DIR (and any other
// vars) are populated before anything below reads them.
import type { RawDatabase } from "@starkeep/storage-adapter";
import "@starkeep/app-client/load-env";
import { createServer } from "node:http";
import { createHmac, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  installLocal,
  uninstallLocal,
  LocalInstallError,
  ManifestValidationError,
} from "../../packages/admin-installer/src/local/installer.js";
import {
  appRegistryRow,
  listAppRegistry,
  listInstallSteps,
} from "../../packages/admin-installer/src/local/registry.js";
import { LOCAL_WATCHER_APP_ID } from "../../packages/admin-installer/src/iam.js";
import { canonicalSignedPath, signRequest, USER_TOKEN_HEADER, APP_SIG_MAX_SKEW_MS } from "../../packages/app-client/src/sign.js";
import { SqliteDatabaseAdapter } from "../../packages/storage-sqlite/src/adapter.js";
import { nodeSqliteDriver } from "../../packages/storage-sqlite/src/node-driver.js";
import {
  SqliteAppSyncableNamespaceStore,
  SqliteAppSyncableApplier,
  sqliteCompiler as qb,
} from "../../packages/storage-sqlite/src/index.js";
import { createAppSpecificFactory } from "../../packages/shared-space-api/src/app-syncable/factory.js";
import { queryParamsFrom } from "../../packages/shared-space-api/src/query/params.js";
import {
  planLabelQuery,
  planMetadataQuery,
  type SharedQueryPlan,
} from "../../packages/shared-space-api/src/query/shared-plan.js";
import {
  assertRecordParams,
  planRecordQuery,
  type RecordQueryPlan,
} from "../../packages/shared-space-api/src/query/records-plan.js";
import { ApiError } from "../../packages/shared-space-api/src/errors.js";
import { FsObjectStorageAdapter } from "../../packages/storage-fs/src/adapter.js";
import type { Filter } from "../../packages/storage-adapter/src/database/types.js";
import { createNodeClock, createStarkeepSdk } from "../../packages/sdk/src/sdk.js";
import { createSqliteSyncStateStore, createChangeNotifier } from "../../packages/sync-engine/src/index.js";
import { setHashFactory } from "@starkeep/storage-adapter";
import {
  labelPageFrom,
  LABEL_QUERY_TARGET,
} from "../../packages/storage-adapter/src/database/label-find.js";
import { createSyncSupervisor, DRIVE_APP_ID, type SyncSupervisor } from "./sync-supervisor.js";
import {
  typeCategory,
  isCategoryId,
  isKnownType,
  checkMetadataValues,
  type Category,
} from "../../packages/protocol-primitives/src/types/core-types.js";
import {
  buildAccessGrants,
  canRead,
  canWrite,
  canWriteCategory,
  canWriteMetadataCategory,
  type AccessGrants,
} from "../../packages/protocol-primitives/src/access/grants.js";
import { deserializeHLC } from "../../packages/protocol-primitives/src/hlc/index.js";
import { dataRecordObjectKey, appSyncableObjectKey, contentHashFromDataRecordObjectKey } from "../../packages/protocol-primitives/src/storage/object-keys.js";
import { sha256HexToBase64, loadVariantCandidatesForPage } from "@starkeep/storage-adapter";
import type { RecordAvailability } from "@starkeep/protocol-primitives";
import {
  createResidencyManager,
  residencyHooks,
  runAcquisition,
  scanForAcquirable,
} from "../../packages/sync-engine/src/index.js";
import type { SyncEngine } from "../../packages/sync-engine/src/index.js";
import {
  createStarkeepId,
  planLabelWrites,
  planLabelRetractions,
  labelValueSetKey,
  DEFAULT_STAND_IN_STANDARDS,
  DEFAULT_SYNC_DOWN_CEILINGS,
  STAND_IN_CATEGORIES,
  STAND_IN_MIME_TYPES,
  standardsFor,
  stampFor,
  type StandInCategory,
  type StandInSize,
  type SyncDownCeilings,
} from "@starkeep/protocol-primitives";
import {
  liveStandIn,
  planFidelityReport,
  planOriginalFidelity,
  planStandInWrite,
  reconcileReportedFidelity,
  recordOriginalFidelity,
  retireReplacedStandIns,
  markSelfCanonical,
  standInExists,
} from "../../packages/shared-space-api/src/stand-ins/write.js";
import {
  applyRecordDelete,
  planRecordDelete,
} from "../../packages/shared-space-api/src/stand-ins/delete.js";
import {
  BACKLOG_KINDS,
  countBacklog,
  pageBacklog,
  type BacklogKind,
} from "../../packages/shared-space-api/src/stand-ins/backlog.js";
import { isStandInSlotConflict, loadStandInSummariesForPage } from "@starkeep/storage-adapter";
import {
  renderStandInSummary,
  resolveContentRead,
} from "../../packages/shared-space-api/src/stand-ins/read.js";
import type { AnyRecord, RecordLabel, DataRecord } from "@starkeep/protocol-primitives";
import type { MetadataRow, StarkeepId } from "@starkeep/protocol-primitives";
import { starkeepDir } from "@starkeep/app-client";
import { join } from "node:path";
import { homedir } from "node:os";
import { stat as fsStat, readFile, writeFile, mkdir, unlink, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { parseRangeHeader } from "./range.js";
import { pipeline } from "node:stream/promises";
import { openSync, mkdirSync } from "node:fs";
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

/**
 * Use Node's native SHA-256 rather than the portable default.
 *
 * The storage adapter defaults to a pure-JS hash so it can be bundled for React
 * Native at all — `node:crypto` at module scope makes the whole package
 * unbundleable there. A server has no such constraint and hashes every byte of
 * every blob it transfers, so it opts into the fast implementation here.
 *
 * Installed before anything can hash, which on this process means before the
 * sync engine exists.
 */
setHashFactory(() => {
  const hash = createHash("sha256");
  return {
    update: (chunk) => void hash.update(chunk),
    digestHex: () => hash.digest("hex"),
  };
});

const STARKEEP_DIR = starkeepDir();
const PORT = parseInt(process.env.STARKEEP_PORT || "9820", 10);
// A supervisor that cannot rely on the parent/child link may name itself here,
// and this daemon exits once that pid is gone. The link is not always available:
// restartProcess() deliberately detaches the replacement, so anything that
// started this server loses its handle the first time a PATCH /config lands, and
// the replacement then outlives its owner with nothing to reap it. Set by the
// test harness (packages/testkit) to the test process's pid; unset in normal
// operation, where the daemon is meant to outlive whoever launched it.
const OWNER_PID = parseInt(process.env.STARKEEP_EXIT_WITH_PID || "", 10);
const OWNER_CHECK_INTERVAL_MS = 5_000;
// Intentionally not configurable. The request-auth model in this server treats
// the loopback bind as the boundary for administrative and host-level routes
// (see LOOPBACK_AUTHORIZED_PATTERNS below). Changing this address without
// also revisiting which routes skip app HMAC would silently de-authenticate
// the admin surface, the watch CRUD, /events, and /auth/*.
const LISTEN_HOST = "127.0.0.1";
const BIND_IS_LOOPBACK = LISTEN_HOST === "127.0.0.1" || LISTEN_HOST === "::1";
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

function grantsForApp(db: RawDatabase, appId: string): AppGrantRow[] {
  // access_grants are keyed by extension (type_id = extension); one row per
  // declared extension. Drive (the User-Data-Owner) writes no rows — it is
  // granted all-access by app id below — so this is a plain lookup.
  const query = qb
    .selectFrom("shared_access_grants")
    .select(["type_id", "access", "metadata_write"])
    .where("app_id", "=", appId)
    .compile();
  return db
    .prepare(query.sql)
    .all(...(query.parameters as string[])) as unknown as AppGrantRow[];
}

// All-access local identities: Starkeep Drive (the User-Data-Owner) and the
// local watcher. Both operate on all shared data — every extension plus the
// Drive-only `other` catch-all — which cannot be represented as a finite set of
// type grant rows, so they are authorized by app id (matching the cloud
// access-enforcer for Drive). `type` is the record's Starkeep type id.
const ALL_ACCESS_APP_IDS = new Set<string>([DRIVE_APP_ID, LOCAL_WATCHER_APP_ID]);

// Resolve one app's grant snapshot from the local SQLite grant rows. The
// grant→category derivation and the `can*` predicates are shared with the
// cloud-data-server (see @starkeep/protocol-primitives `access/grants.ts`);
// this server supplies only the SQLite grant source and the local all-access
// policy (Drive + the watcher).
function appGrants(db: RawDatabase, appId: string): AccessGrants {
  return buildAccessGrants(
    grantsForApp(db, appId).map((g) => ({
      typeId: g.type_id,
      access: g.access,
      metadataWrite: g.metadata_write === 1,
    })),
    { allAccess: ALL_ACCESS_APP_IDS.has(appId) },
  );
}

function appCanRead(db: RawDatabase, appId: string, type: string): boolean {
  return canRead(appGrants(db, appId), type);
}

function appCanWrite(db: RawDatabase, appId: string, type: string): boolean {
  return canWrite(appGrants(db, appId), type);
}

// Category-level access. Object-storage keys (`shared/<category>/…`) and the
// per-category metadata tables are category-namespaced (so is the IAM ceiling),
// so they authorize against the categories the app's type grants map to —
// a category is accessible when at least one granted type maps to it.
function appCanWriteCategory(db: RawDatabase, appId: string, category: string): boolean {
  return canWriteCategory(appGrants(db, appId), category);
}

function appCanWriteMetadataCategory(db: RawDatabase, appId: string, category: string): boolean {
  return canWriteMetadataCategory(appGrants(db, appId), category);
}

/** The label keys an app's manifest declares. Read per label-write request,
 *  the same shape and cost as the grants load. */
function appDeclaredLabelKeys(db: RawDatabase, appId: string): Set<string> {
  const query = qb
    .selectFrom("shared_app_label_keys")
    .select("key")
    .where("app_id", "=", appId)
    .compile();
  const rows = db.prepare(query.sql).all(...(query.parameters as string[])) as Array<{
    key: string;
  }>;
  return new Set(rows.map((r) => r.key));
}

function getAppHmacSecret(db: RawDatabase, appId: string): string | null {
  const query = qb
    .selectFrom("shared_app_registry")
    .select("hmac_secret")
    .where("app_id", "=", appId)
    .where("status", "=", "active")
    .compile();
  const row = db
    .prepare(query.sql)
    .get(...(query.parameters as string[])) as { hmac_secret: string } | undefined;
  return row?.hmac_secret ?? null;
}

function validateAppHmac(
  db: RawDatabase,
  appId: string,
  method: string,
  path: string,
  body: Buffer,
  sig: string | undefined,
  ts: string | undefined,
): boolean {
  if (!sig || !ts) return false;
  // Reject stale or future-dated signatures (replay-window bound, with skew
  // tolerance). Mirrors the cloud verifier.
  const tsMs = Number(ts);
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > APP_SIG_MAX_SKEW_MS) {
    return false;
  }
  const secret = getAppHmacSecret(db, appId);
  if (!secret) return false;
  // HMAC over raw bytes: `${appId}:${METHOD}:${path}:${ts}:` (utf-8) ++ body
  // bytes. Binding method/path/ts stops cross-endpoint and indefinite replay;
  // operating on bytes (not a fully-stringified message) keeps binary payloads
  // lossless. Mirrors `signRequest` in @starkeep/app-client/src/sign.ts.
  const prefix = Buffer.from(
    `${appId}:${method.toUpperCase()}:${canonicalSignedPath(path)}:${tsMs}:`,
    "utf8",
  );
  const input = Buffer.concat([prefix as unknown as Uint8Array, body as unknown as Uint8Array]);
  const expected = createHmac("sha256", secret).update(input as unknown as Uint8Array).digest("hex");
  // timingSafeEqual requires equal-length buffers
  const sigBuf = Buffer.from(sig, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expBuf.length) return false;
  return timingSafeEqual(sigBuf as unknown as Uint8Array, expBuf as unknown as Uint8Array);
}

const STARKEEP_CONFIG_PATH = join(STARKEEP_DIR, "config.json");

interface StarkeepConfig {
  // Generated once at first boot, persisted forever. Feeds the HLC clock, so
  // it must be unique per replica — never read this from env or default it.
  nodeId: string;
  pullIntervalMs?: number;
  pushDebounceMs?: number;
  /**
   * Byte budget for one exchange round (sync-engine `maxBytes`). Default 25 MB.
   * The budget that binds on a channel carrying files.
   */
  syncMaxBytes?: number;
  /** Item cap for one exchange round (sync-engine `maxItems`). Default 1000. */
  syncMaxItems?: number;
  /**
   * This node's sync-down ceiling per stand-in category, overriding the
   * desktop default. A local data server always runs on a desktop or laptop. A number is the largest fidelity the node receives
   * without being asked; `null` receives none of that category by default.
   * Changed by the person, per node, from admin-web.
   */
  standInCeilings?: Partial<Record<StandInCategory, number | null>>;
  /**
   * Whether this node keeps every original, as a backup machine would. Sync
   * then receives every original, and "Free up space" leaves them. Off unless
   * the person turns it on, per node, from admin-web.
   */
  keepOriginals?: boolean;
  // Cloud fields — populated by the admin wizard's PATCH /config, absent
  // until then. nodeId stands alone so cloud-disabled installs still get a
  // stable replica identity.
  stage?: string;
  userPoolId?: string;
  userPoolClientId?: string;
  identityPoolId?: string;
  s3Bucket?: string;
  s3Region?: string;
  auroraEndpoint?: string;
  apiGatewayUrl?: string;
  /**
   * How many Lambda invocations the cloud account can have in flight at once.
   *
   * Nothing on this node enforces it. It lives here because this is where the
   * operator's cloud settings live, and the installer reads it from here to
   * hand to app compute — a client that fans out on the user's behalf needs the
   * real ceiling to size that fan-out against, and the unraised default of ten
   * is low enough that guessing produces 503s which read as app bugs.
   */
  lambdaConcurrency?: number;
}

// Detects the unique-violation from the
// (parent_id, original_filename, content_hash) index in storage-sqlite
// bootstrap and mirrored in DSQL. Postgres surfaces SQLSTATE 23505 naming the
// index, and SQLite names the index too now that the index is on expressions —
// "UNIQUE constraint failed: index 'uq_shared_records_parent_filename_hash'"
// rather than the column list it reports for a plain one. So matching the index
// name covers both without a driver dep, which the comment here claimed before
// the expressions made it true.
function isDuplicateFileError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("uq_shared_records_parent_filename_hash") ||
    message.includes("uq_records_parent_filename_hash")
  );
}

/**
 * This node's ceilings: the desktop defaults, with the person's
 * per-category changes on top. A malformed configured value is ignored with a
 * warning rather than trusted — the PUT route refuses one, so only a
 * hand-edited config file can carry it.
 */
function resolveCeilings(config: Pick<StarkeepConfig, "standInCeilings">): SyncDownCeilings {
  const out: Record<StandInCategory, number | null> = { ...DEFAULT_SYNC_DOWN_CEILINGS.desktop };
  for (const category of STAND_IN_CATEGORIES) {
    const configured = config.standInCeilings?.[category];
    if (configured === undefined) continue;
    if (configured === null || (Number.isInteger(configured) && configured > 0)) {
      out[category] = configured;
    } else {
      console.warn(`[residency] ignoring standInCeilings.${category} = ${String(configured)}; keeping ${out[category]}`);
    }
  }
  return out;
}

/**
 * What every original in the library weighs, per stand-in category, from the
 * records table. With the bytes this node holds, it tells the person roughly
 * what turning on "Keep originals here" would download.
 */
function originalBytesByCategory(db: RawDatabase): Record<StandInCategory, { count: number; bytes: number }> {
  const query = qb
    .selectFrom("shared_records")
    .select(({ fn }) => [
      "type",
      fn.countAll<number>().as("count"),
      fn.sum<number>("size_bytes").as("bytes"),
    ])
    .where("parent_id", "is", null)
    .where("stand_in_role", "is", null)
    .where("deleted_at", "is", null)
    .where("object_storage_key", "is not", null)
    .groupBy("type")
    .compile();
  const rows = db.prepare(query.sql).all(...(query.parameters as string[])) as Array<{
    type: string;
    count: number;
    bytes: number | null;
  }>;
  const out = Object.fromEntries(
    STAND_IN_CATEGORIES.map((c) => [c, { count: 0, bytes: 0 }]),
  ) as Record<StandInCategory, { count: number; bytes: number }>;
  for (const row of rows) {
    const category = standardsFor(row.type, DEFAULT_STAND_IN_STANDARDS)?.category;
    if (!category) continue;
    out[category].count += row.count;
    out[category].bytes += row.bytes ?? 0;
  }
  return out;
}

function ceilingProblems(body: {
  ceilings?: Record<string, unknown>;
  keepOriginals?: unknown;
}): string[] {
  const problems: string[] = [];
  if (body.keepOriginals !== undefined && typeof body.keepOriginals !== "boolean") {
    problems.push("keepOriginals must be true or false");
  }
  for (const [category, value] of Object.entries(body.ceilings ?? {})) {
    if (!(STAND_IN_CATEGORIES as readonly string[]).includes(category)) {
      problems.push(`${category} is not a stand-in category (${STAND_IN_CATEGORIES.join(", ")})`);
    } else if (value !== null && !(typeof value === "number" && Number.isInteger(value) && value > 0)) {
      problems.push(`${category}: a ceiling is a positive whole fidelity, or null for none`);
    }
  }
  return problems;
}

function regionFromUserPoolId(userPoolId: string): string {
  const parts = userPoolId.split("_");
  return parts.length > 1 ? parts[0] : "";
}

interface PersistedAuth {
  refreshToken: string;
  idToken?: string;
}

function restartProcess(): void {
  console.log("[server] Restarting to apply config changes…");
  // Re-exec the *same* interpreter invocation. process.argv.slice(1) carries
  // the script + its args but NOT the node flags in process.execArgv — under
  // tsx those flags are the `--import tsx` loader, without which the respawn
  // crashes with ERR_MODULE_NOT_FOUND on the repo's `.js`-suffixed TS imports.
  // execArgv is empty in a plain-`node` / compiled deployment, so this reduces
  // to the previous behavior there.
  //
  // The replacement is detached and must NOT inherit this (exiting) process's
  // stdio: inheriting a parent's pipes leaves the daemon writing into a closed
  // reader once we exit. Redirect its output to an append-only log file under
  // STARKEEP_DIR so logs survive the restart and the child is fully detached.
  mkdirSync(STARKEEP_DIR, { recursive: true });
  const logFd = openSync(join(STARKEEP_DIR, "local-data-server.log"), "a");
  const child = spawn(
    process.execPath,
    [...process.execArgv, ...process.argv.slice(1)],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
      cwd: process.cwd(),
    },
  );
  child.unref();
  // The replacement has no parent link to whoever started us, so its pid is the
  // only handle anyone gets. Print it before exiting (stdout is synchronous on
  // POSIX pipes and files, so this survives the exit) — the test harness reads
  // it back off our stdout to reap the replacement at teardown, and an operator
  // reading the log can tell which process is now serving.
  console.log(`[server] Restarted as pid ${child.pid}`);
  process.exit(0);
}

/**
 * Exit when the process named by STARKEEP_EXIT_WITH_PID goes away.
 *
 * Signal 0 tests for existence without delivering anything. EPERM means the pid
 * is alive but owned by another user, which still counts as present. Nothing
 * here signals the owner — the only process this can ever kill is our own.
 *
 * The pid could in principle be recycled by an unrelated process, which would
 * keep the guard from firing; that only delays cleanup and never takes down the
 * wrong process, so no attempt is made to detect it.
 */
function exitWhenOwnerIsGone(shutdown: () => Promise<void>): void {
  // Strictly positive: 0 and negatives address process *groups* in kill(2), and
  // this is only ever meant to name one process.
  if (!Number.isFinite(OWNER_PID) || OWNER_PID <= 0) return;
  const timer = setInterval(() => {
    try {
      process.kill(OWNER_PID, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") return;
      clearInterval(timer);
      console.log(`[server] Owner process ${OWNER_PID} is gone — shutting down.`);
      void shutdown();
    }
  }, OWNER_CHECK_INTERVAL_MS);
  // Never a reason to hold the event loop open on its own.
  timer.unref();
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

async function loadStarkeepConfig(): Promise<StarkeepConfig> {
  // First boot, or a config file written before nodeId existed: synthesize
  // one and persist. nodeId being absent would let two replicas share the
  // same HLC identity and corrupt the Drive watermark map, so we never
  // tolerate a missing or empty value here.
  let parsed: Partial<StarkeepConfig> = {};
  try {
    parsed = JSON.parse(await readFile(STARKEEP_CONFIG_PATH, "utf8"));
  } catch {
    console.warn(`No config found at ${STARKEEP_CONFIG_PATH} — cloud features disabled until setup`);
  }
  if (!parsed.nodeId) {
    parsed.nodeId = randomUUID();
    await mkdir(STARKEEP_DIR, { recursive: true });
    await writeFile(STARKEEP_CONFIG_PATH, JSON.stringify(parsed, null, 2), "utf8");
    console.log(`Generated nodeId ${parsed.nodeId} and wrote ${STARKEEP_CONFIG_PATH}`);
  }
  return parsed as StarkeepConfig;
}

/**
 * Assemble the Cognito config from a StarkeepConfig, or null if the three
 * required pool fields aren't all present. Region is derived from the
 * userPoolId (AWS encodes it in the prefix), never stored separately.
 *
 * Callers that authenticate must derive this from a *freshly loaded* config
 * rather than a boot-time snapshot: the admin panel writes the pool IDs to
 * ~/.starkeep/config.json directly (it does not restart this daemon), so a
 * value captured at boot goes stale the moment cloud setup fills them in.
 */
function cognitoConfigFrom(config: StarkeepConfig): CognitoConfig | null {
  if (!config.userPoolId || !config.userPoolClientId || !config.identityPoolId) {
    return null;
  }
  return {
    region: regionFromUserPoolId(config.userPoolId),
    userPoolId: config.userPoolId,
    userPoolClientId: config.userPoolClientId,
    identityPoolId: config.identityPoolId,
  };
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

/**
 * Missing files a batch file-url read fetches at once. The Drive channel moves
 * each file whole, so a batch of originals at full width would compete with
 * the sync round for the same link.
 */
const FILE_URL_FETCH_CONCURRENCY = 4;

/** Run `work` over `items`, at most `limit` at a time. */
async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await work(item);
    }
  });
  await Promise.all(workers);
}

async function saveCloudCredentials(creds: STSCredentials): Promise<void> {
  await mkdir(STARKEEP_DIR, { recursive: true });
  await writeFile(join(STARKEEP_DIR, "cloud-credentials.json"), JSON.stringify(creds, null, 2), "utf8");
}

/**
 * Run one shared-plane query and write its page.
 *
 * The plan — parse, then the caller's grant as a predicate — is built by
 * `shared-plan.ts` and shared with the cloud handler, so the two servers cannot
 * drift on the one thing that matters here. What stays local is the transport:
 * a status code and a JSON body.
 */
/**
 * The status a thrown rejection means, or null when it is the server's.
 *
 * A parse rejection and a grant denial are both the caller's, and both carry
 * the status they mean. Anything else rethrows, because a 500 that reads as a
 * 400 is a bug hidden behind a plausible answer.
 */
function clientErrorStatus(err: unknown): number | null {
  if (err instanceof ApiError) return err.statusCode;
  return (err as { status?: number }).status === 400 ? 400 : null;
}

async function runSharedQuery(
  res: import("node:http").ServerResponse,
  adapter: SqliteDatabaseAdapter,
  build: () => SharedQueryPlan,
): Promise<void> {
  let plan: SharedQueryPlan;
  try {
    plan = build();
  } catch (err) {
    const status = clientErrorStatus(err);
    if (status === null) throw err;
    res.writeHead(status);
    json(res, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const result = await adapter.queryShared(plan.target, plan.query, {
    serverWhere: plan.serverWhere,
  });
  json(res, result.mode === "rows"
    ? { rows: result.rows, truncated: result.truncated, page_token: result.pageToken }
    : { groups: result.groups, truncated: result.truncated });
}

async function main() {
  const databaseAdapter = new SqliteDatabaseAdapter({
    path: join(STARKEEP_DIR, "data.db"),
    driver: nodeSqliteDriver,
  });

  // Local FS is always available — acts as a cache when S3 is configured
  const objectsBasePath = join(STARKEEP_DIR, "objects");
  const localAdapter = new FsObjectStorageAdapter({
    basePath: objectsBasePath,
  });

  /** Where a record's bytes sit, as this node answers for a size summary. */
  const localPlacementOf = async (record: DataRecord): Promise<"here" | "cloud"> =>
    record.objectStorageKey && (await localAdapter.has(record.objectStorageKey)) ? "here" : "cloud";

  /**
   * A summary entry's URL: a local file token for bytes on this disk, and none
   * for bytes only the cloud holds. A cloud URL per entry would be a cloud
   * round trip per size per record on every page; `content-url` answers the
   * one a reader actually wants.
   */
  const localStandInUrl = async (size: StandInSize): Promise<string | undefined> => {
    if (size.placement !== "here" || !size.objectStorageKey) return undefined;
    return `http://127.0.0.1:${PORT}/data/files/${createFileToken(
      size.objectStorageKey,
      mimeForStandIn(size.type ?? ""),
      VARIANT_URL_TTL_SECONDS,
    )}`;
  };

  // Load runtime config from ~/.starkeep/config.json. nodeId is guaranteed
  // present (generated and persisted on first boot inside loadStarkeepConfig).
  const starkeepConfig = await loadStarkeepConfig();
  const NODE_ID = starkeepConfig.nodeId;
  const PULL_INTERVAL_MS = starkeepConfig.pullIntervalMs ?? 30000;
  const PUSH_DEBOUNCE_MS = starkeepConfig.pushDebounceMs ?? 500;
  const configRegion = starkeepConfig.userPoolId
    ? regionFromUserPoolId(starkeepConfig.userPoolId)
    : "";
  if (starkeepConfig.stage) {
    console.log(`Cloud config loaded: stage=${starkeepConfig.stage}, region=${configRegion}`);
    if (starkeepConfig.s3Bucket) console.log(`  S3 bucket=${starkeepConfig.s3Bucket}`);
    if (starkeepConfig.auroraEndpoint) console.log(`  DSQL=${starkeepConfig.auroraEndpoint}`);
    if (starkeepConfig.apiGatewayUrl) console.log(`  API=${starkeepConfig.apiGatewayUrl}`);
  }

  const CLOUD_URL = starkeepConfig.apiGatewayUrl ?? undefined;

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

  // Boot-time snapshot — used only to decide whether to start the credential
  // refresh timer below. Request handlers that authenticate must NOT trust this
  // (it goes stale once cloud setup writes the pool IDs); they reload from disk.
  const cognitoConfig: CognitoConfig | null = cognitoConfigFrom(starkeepConfig);

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

  // App identities are stored in shared_app_registry; populated by the
  // installer (POST /admin/apps/install). No startup-time auto-discovery —
  // apps appear only after going through install.

  // Pre-init so we can hand the raw SQLite handle to the sync state store,
  // which shares the records DB file.
  await databaseAdapter.init();

  // The state store is used by the SDK for HLC clock state (global, one clock
  // per node); per-app watermarks are owned by the supervisor's per-app
  // adapters around it.
  const syncStateStore = CLOUD_URL
    ? createSqliteSyncStateStore({ db: databaseAdapter.getRawDatabase() })
    : undefined;

  // **One clock per node id, shared with the SDK below rather than a second
  // instance beside it.** This process used to build its own here and let the
  // SDK build another from the same `NODE_ID`, so route handlers stamped label
  // writes from one clock while the records those labels belonged to were
  // stamped from the other. Two clocks under one author identity destroy the
  // property the sync watermark depends on — see `createNodeClock`, which also
  // records what that cost on a real handset. It is built after the state
  // store because it seeds from it; nothing above needs a clock.
  const nodeClock = await createNodeClock({ nodeId: NODE_ID, syncStateStore });
  const clock = nodeClock.clock;

  // Direct sqlite handle for app-identity / grant lookups. The records-layer
  // adapter operates on the same DB; we use raw access for the shared_*
  // tables (registry, grants) that have no adapter wrapper.
  const localDb = databaseAdapter.getRawDatabase();

  // The node's residency: every file no stand-in can replace, every stand-in
  // at or below this node's ceilings, and whatever someone asks for. Nothing
  // is removed except through "Free up space".
  const ceilings = resolveCeilings(starkeepConfig);
  const residencyManager = createResidencyManager({
        localDb,
        databaseAdapter,
        localObjectStorage: localAdapter,
        // The local data server is never the cloud node. `starkeep/no-cloud`
        // is a constraint about cloud storage; a laptop holding such a record
        // is the intended outcome, not a violation.
        isCloudNode: false,
        ceilings,
        keepOriginals: starkeepConfig.keepOriginals === true,
      });

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
    nodeId: NODE_ID,
    syncStateStore,
    changeNotifier,
    getAppSpecific: appSpecificFactory,
    // The same instance the route handlers and the app-specific factory use.
    clock,
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

  /**
   * Whether this record's bytes are on this node, fetching them through the
   * Drive channel when they are not. The on-demand half of residency: a read
   * of a file above this node's ceiling brings the file here, and the file
   * stays until "Free up space".
   *
   * A local read never hands out a presigned S3 URL. The person's own
   * identity may read only `apps/admin/*`, so a presign for a `shared/` key
   * always answers 403; only Drive's role reads shared bytes.
   */
  async function ensureLocalBytes(record: AnyRecord): Promise<boolean> {
    if (!record.objectStorageKey) return false;
    if (await localAdapter.has(record.objectStorageKey)) return true;
    return (await supervisor?.fetchSharedBlob(record)) ?? false;
  }

  // Files a round declined that this node now wants. A ceiling change restarts
  // this process, so one catalogue scan per process finds every file a raised
  // ceiling now covers, along with any bytes that went missing here — the scan
  // starts by reconciling the index against the disk. The acquisition pass
  // then fetches the queue after each Drive-channel drain.
  let scanCursor: string | null = null;
  let scanComplete = false;
  async function acquireWanted(
    engine: SyncEngine,
    signal: { readonly aborted: boolean },
  ): Promise<void> {
    if (!scanComplete && scanCursor === null) await residencyManager.reconcile();
    while (!scanComplete && !signal.aborted) {
      const scan = await scanForAcquirable({
        databaseAdapter,
        consider: (candidate) => residencyManager.considerForAcquisition(candidate),
        cursor: scanCursor,
        maxRecords: 2_000,
      });
      scanCursor = scan.nextCursor;
      scanComplete = scan.nextCursor === null;
    }
    while (!signal.aborted) {
      const pass = await runAcquisition({
        engine,
        manager: residencyManager,
        databaseAdapter,
        maxBytes: starkeepConfig.syncMaxBytes ?? 25 * 1024 * 1024,
      });
      // A page that neither landed nor dropped anything holds only failures,
      // which the next drain retries.
      if (pass.landed === 0 && pass.dropped === 0) break;
    }
  }

  if (CLOUD_URL && syncStateStore) {
    supervisor = createSyncSupervisor({
      sdk,
      databaseAdapter,
      localObjectStorage: localAdapter,
      residency: residencyHooks(residencyManager),
      afterDriveDrain: acquireWanted,
      localDb: databaseAdapter.getRawDatabase(),
      cloudUrl: CLOUD_URL,
      // Outbound auth is both: the per-request HMAC identifies the app, and
      // the ID token identifies the person it is syncing for. The broker
      // requires both. An accessor rather than the value, because engines
      // outlive the hourly token — see makeSignerFor in sync-supervisor.ts.
      getIdToken: () => currentIdToken,
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
      maxBytes: starkeepConfig.syncMaxBytes,
      maxItems: starkeepConfig.syncMaxItems,
    });
  }

  // Built-in local file-watcher identity. All records originated by LDS
  // built-in features (notably the file watcher) are stamped with this appId
  // as their immutable origin_app_id, both in the local change log and on the
  // wire. This is a *local-only* identity: its records are shared records that
  // sync to the cloud via the Starkeep Drive channel under Drive's role — there
  // is no dedicated cloud write-role for it. Its grants flow
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
  //   - the always-on Drive sync engine is the legitimate all-access identity
  //     that scans all shared records for the single Drive channel;
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
    objectStorageAdapter: localAdapter,
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
    // The `x-amz-*` entries are the upload headers this server's own presign
    // route invites. It returns `checksumSha256` deliberately, "for parity with
    // the cloud broker so one client code path works against either backend" —
    // and a client that takes that parity at its word sends the header back on
    // the PUT. Omitting it here refused the preflight, so every browser-side
    // upload against a local node failed as an opaque `TypeError: Failed to
    // fetch` with nothing in it to say a header was the reason.
    //
    // This grants no authority: the upload route is authorized by the signed
    // token in its URL, and `Allow-Headers` only decides which headers a
    // browser will let a page attach. `storageClass` and `tagging` are listed
    // too, because a client written against the cloud contract sends all three
    // and the whole point of the parity is that it should not have to know
    // which backend answered.
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, X-Starkeep-App-Id, X-Starkeep-App-Sig, X-Starkeep-App-Ts, " +
        "x-amz-checksum-sha256, x-amz-storage-class, x-amz-tagging",
    );

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
    const appTs = req.headers["x-starkeep-app-ts"] as string | undefined;

    const LOOPBACK_AUTHORIZED_PATTERNS = [
      /^\/health$/,
      /^\/config$/,
      /^\/auth(\/|$)/,
      /^\/admin(\/|$)/,
      /^\/watches(\/|$)/,
      /^\/events$/,
      // This node's sync-down ceilings and the person's "Free up space".
      // Operator controls over this machine's disk, loopback-gated rather than
      // app-gated: they are facts about the machine, not about anybody's
      // library, and the report carries aggregate byte counts and no record
      // ids, filenames or content. "Free up space" deletes local bytes, so a loopback caller can use it to
      // empty this node's copies — but only of files whose original, canonical
      // stand-in and own bytes are proved in the cloud, which leaves nothing
      // unrecoverable, and never of a file at or below the ceiling.
      /^\/residency\/(stand-ins|free-up-space)$/,
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
        req.method === "GET" || req.method === "HEAD"
          ? Buffer.alloc(0)
          : await readBodyBuffer(req);
      if (!validateAppHmac(localDb, appId, req.method ?? "GET", path, rawBody, appSig, appTs)) {
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
        const freshRegion = freshConfig.userPoolId
          ? regionFromUserPoolId(freshConfig.userPoolId)
          : "";
        json(res, {
          stage: freshConfig.stage ?? null,
          s3Bucket: freshConfig.s3Bucket ?? null,
          s3Region: freshConfig.s3Region ?? freshRegion,
          auroraEndpoint: freshConfig.auroraEndpoint ?? null,
          apiGatewayUrl: freshConfig.apiGatewayUrl ?? null,
          cognitoConfig: freshConfig.userPoolId
            ? {
                region: freshRegion,
                userPoolId: freshConfig.userPoolId,
                userPoolClientId: freshConfig.userPoolClientId,
                identityPoolId: freshConfig.identityPoolId,
              }
            : null,
        });
        return;
      }

      if (path === "/config" && req.method === "PATCH") {
        const patch = JSON.parse(await readBody(req)) as Partial<StarkeepConfig>;
        // nodeId is generated once on first boot and must never change.
        delete (patch as { nodeId?: unknown }).nodeId;
        const updated: StarkeepConfig = { ...starkeepConfig, ...patch };
        await writeFile(STARKEEP_CONFIG_PATH, JSON.stringify(updated, null, 2), "utf8");
        Object.assign(starkeepConfig, patch);
        json(res, { ok: true });
        setTimeout(restartProcess, 200);
        return;
      }

      if (path === "/auth/status" && req.method === "GET") {
        // Reload from disk so this reflects setup that completed after boot.
        const freshCognito = cognitoConfigFrom(await loadStarkeepConfig());
        json(res, {
          configLoaded: freshCognito !== null,
          authenticated: currentRefreshToken !== null,
        });
        return;
      }

      if (path === "/auth/login" && req.method === "POST") {
        // Reload from disk: the admin panel writes the Cognito pool IDs to
        // config.json without restarting this daemon, so the boot-time snapshot
        // may be stale (null) even though setup is complete.
        const cognitoConfig = cognitoConfigFrom(await loadStarkeepConfig());
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
        // Reload from disk — see the note in /auth/login. The boot-time
        // cognitoConfig const is null until this daemon is restarted, but cloud
        // setup writes the pool IDs directly to config.json.
        const cognitoConfig = cognitoConfigFrom(await loadStarkeepConfig());
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

      // POST /sync/verify — compare row counts with the cloud on every channel.
      //
      // The check no amount of syncing can perform. A coverage watermark is
      // MAX(updated_at) per author, so a row lost from the *middle* of a range
      // leaves it unchanged: both sides go on believing they agree, and no
      // round ever offers that row again. Counting rows per time bucket finds
      // it, in both directions, and arms a repair that the next ordinary sync
      // carries out.
      //
      // A request rather than a timer because it is a grouped scan over the
      // whole index on both sides — cheap, but not cheap enough to run on a
      // tick, and it answers a question that only changes when something has
      // already gone wrong.
      if (path === "/sync/verify" && req.method === "POST") {
        if (!supervisor) {
          res.writeHead(400);
          json(res, { error: "sync not configured" });
          return;
        }
        json(res, { channels: await supervisor.verifyAll() });
        return;
      }

      // GET /cloud/data/types and /cloud/data/records — read-only proxy to the
      // cloud-data-server, signed with the calling app's per-app HMAC. The app
      // (e.g. starkeep-drive) authenticates to *us* with its HMAC as usual; we
      // then re-sign as that same app for the cloud, exactly like the sync
      // supervisor does (see sync-supervisor.ts → makeSignerFor). The cloud's
      // verifier (cloud-data-server/api-handler.ts → validateAppHmac) requires
      // every /apps/{appId}/* request to carry X-Starkeep-App-{Id,Sig,Ts}; a
      // bearer JWT is not accepted there. The cloud enforces the same per-app
      // grants for /apps/{appId}/data/*, so this exposes no data the app
      // couldn't already sync. Lets the Drive UI show the cloud-side view (what
      // actually pushed) next to the local view.
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
        const hmacSecret = appRegistryRow(localDb, appId!)?.hmacSecret;
        if (!hmacSecret) {
          res.writeHead(503);
          json(res, { error: `No hmac_secret in local registry for app '${appId}' — re-run its local install` });
          return;
        }
        // The cloud data plane wants both halves of the credential: the HMAC
        // says which app is calling, the ID token says a real person is behind
        // it, and neither substitutes for the other (see the cloud's
        // api-handler → "Missing X-Starkeep-User-Token"). Refuse here rather
        // than forward a request that can only come back 401, so the Drive UI
        // says "not signed in" instead of quoting a header name at the user.
        if (!idTokenIsLive()) {
          res.writeHead(503);
          json(res, { error: "Not signed in to the cloud — sign in to see the cloud view" });
          return;
        }
        const subPath = path.slice("/cloud".length); // "/data/types" | "/data/records"
        // Sign over the cloud sub-path (everything after /apps/{appId}), since
        // the cloud verifier strips that prefix before checking the signature.
        // The query string is excluded from the signed message (canonicalSignedPath).
        //
        // Both headers, exactly as sync-supervisor.ts → makeSignerFor builds
        // them. This block long carried only the signature, so every call to a
        // cloud that has required an end-user credential since the June auth
        // work came back 401 and Drive showed every record as local-only.
        const signedHeaders = {
          ...signRequest({
            appId: appId!,
            hmacSecret,
            method: "GET",
            path: subPath,
          }),
          [USER_TOKEN_HEADER]: currentIdToken!,
        };
        const cloudUrl = `${CLOUD_URL.replace(/\/+$/, "")}/apps/${encodeURIComponent(appId!)}${subPath}${url.search}`;
        try {
          const cloudRes = await fetch(cloudUrl, { headers: signedHeaders });
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

      // GET /data/types — list record types with counts.
      //
      // One `GROUP BY type` rather than a page counted in JavaScript. The old
      // shape materialized 10,000 records, filtered them by grant afterwards
      // and answered the surviving length, so a library past the cap reported
      // the cap. The grant now rides in as a `type IN (…)` predicate, which is
      // what makes the aggregate both correct and cheap.
      if (path === "/data/types" && req.method === "GET") {
        const grants = appGrants(localDb, appId!);
        if (!grants.allAccess && grants.readableTypes.size === 0) {
          json(res, { types: [], total: 0 });
          return;
        }
        const filters: Filter[] = [{ field: "deletedAt", operator: "isNull" }];
        if (!grants.allAccess) {
          filters.unshift({ field: "type", operator: "in", value: [...grants.readableTypes] });
        }
        const counts = await databaseAdapter.countRecordsByType({ filters });

        const types = counts.map((row) => ({
          record_type: row.type,
          count: row.count,
          // `updated_at` is a serialized HLC whose leading field is hex wall
          // time, so `MAX` over it is the latest write and `deserializeHLC`
          // recovers the instant the old code read off the record object.
          latest_updated: row.latestUpdatedAt
            ? new Date(deserializeHLC(row.latestUpdatedAt).wallTime).toISOString()
            : null,
        }));
        types.sort((a, b) => b.count - a.count);

        json(res, { types, total: counts.reduce((sum, row) => sum + row.count, 0) });
        return;
      }

      /**
       * This app's live values per `(record, key)`, for the value-cardinality
       * cap. A second batched read on the write path, and the reason the cap is
       * a cap rather than a suggestion: counted over the batch alone it is
       * cleared by sending 32 values repeatedly.
       *
       * Tombstoned rows are excluded — a retracted value is a freed slot, and
       * counting it would make a key that has been edited enough times
       * permanently unwritable.
       */
      const appLabelValueSets = async (
        writerAppId: string,
        recordIds: StarkeepId[],
      ): Promise<Map<string, Set<string>>> => {
        const out = new Map<string, Set<string>>();
        if (recordIds.length === 0) return out;
        for (const labels of (
          await databaseAdapter.getLabelsByRecordIds(recordIds)
        ).values()) {
          for (const l of labels) {
            if (l.appId !== writerAppId || l.deletedAt) continue;
            const k = labelValueSetKey(l.recordId, l.key);
            let set = out.get(k);
            if (!set) out.set(k, (set = new Set()));
            set.add(l.value);
          }
        }
        return out;
      };

      /**
       * Resolve a batch of requested label writes into adapter rows, or an
       * error. The `SELECT id, type` here is the part the single-statement
       * upsert hides, and it is very likely the dominant cost of a bulk
       * labelling job — it is what to measure first if one is slow.
       */
      const planLabelWriteBatch = async (
        writerAppId: string,
        entries: Array<{ recordId: StarkeepId; key: string; value?: string }>,
      ) => {
        const ids = [...new Set(entries.map((e) => e.recordId))];
        const found = await databaseAdapter.query({
          filters: [
            { field: "id", operator: "in", value: ids },
            { field: "deletedAt", operator: "isNull" },
          ],
          limit: ids.length,
        });
        const recordTypes = new Map(found.records.map((r) => [r.id as string, r.type]));
        const grants = appGrants(localDb, writerAppId);
        return planLabelWrites({
          entries,
          recordTypes,
          declaredKeys: appDeclaredLabelKeys(localDb, writerAppId),
          // A read grant is enough — see planLabelWrites for why labelling
          // does not require readwrite.
          canReadType: (type) => canRead(grants, type),
          existingValues: await appLabelValueSets(writerAppId, ids),
        });
      };

      // GET /data/records — the query grammar over shared.records, plus the
      // access paths and the hydration that are not grammar.
      //
      //   where={"type":"image/jpeg"}&order=captured_at.desc&limit=100
      //   &page_token=<token>&include=metadata,labels
      //   &label=<appId>/<key>&labelValue=<v>&notLabel=<appId>/<key>
      //
      // `planRecordQuery` parses all of it, and the cloud handler calls the
      // same function, so the two servers cannot drift on what a parameter
      // means. What stays here is the transport, the hydration and the local
      // answers — availability read off this disk, and file URLs on this port.
      if (path === "/data/records" && req.method === "GET") {
        const grants = appGrants(localDb, appId!);

        let plan: RecordQueryPlan;
        try {
          assertRecordParams(url.searchParams.keys());
          plan = planRecordQuery(
            grants,
            (name) => url.searchParams.get(name) ?? undefined,
            // 100 rather than the grammar's 30: this route has answered 100
            // since before the grammar existed, and a caller that never sent
            // `limit` should not find its page size changed by a refactor.
            { defaultLimit: 100 },
          );
        } catch (err) {
          const status = clientErrorStatus(err);
          if (status === null) throw err;
          res.writeHead(status);
          json(res, { error: err instanceof Error ? err.message : String(err) });
          return;
        }

        if (plan.mode === "aggregate") {
          // An aggregate over the readable library, compiled by the same
          // builder the metadata and label routes use. `empty` short-circuits
          // it: `type IN ()` is not a predicate either engine will compile.
          const result = plan.empty
            ? { mode: "aggregate" as const, groups: [], truncated: false }
            : await databaseAdapter.queryShared({ kind: "records" }, plan.aggregate!, {
                serverWhere: plan.serverWhere,
              });
          json(res, {
            groups: result.mode === "aggregate" ? result.groups : [],
            truncated: result.truncated,
          });
          return;
        }

        if (plan.empty) {
          json(res, { records: [], hasMore: false, nextCursor: null });
          return;
        }

        const includeMetadata = plan.includeMetadata;
        const includeLabels = plan.includeLabels;
        const labelApps = plan.labelApps ?? null;
        const variantLabel = plan.variant?.label;

        // Two ways to select a page. The reverse-label query is its own
        // access path, over its own table and in its own order; everything
        // after this point (hydration, rendering) is shared.
        let readable: DataRecord[];
        let pageHasMore: boolean;
        let pageCursor: string | null;

        if (plan.labelPath) {
          // The reverse index, read through the query grammar: the plan carries
          // the parsed query and the grant as the server's own predicate, so
          // unreadable rows are never materialized and the page comes back
          // full. Its page token is the grammar's, cut over `(value,
          // record_id)` — the index's residual order.
          const found = labelPageFrom(
            await databaseAdapter.queryShared(LABEL_QUERY_TARGET, plan.labelPath.query, {
              serverWhere: plan.labelPath.serverWhere,
            }),
          );

          // One batched fetch of the matching records, then restore the
          // index's order — `query` returns id-ascending, which is not the
          // (value, record_id) order the cursor is keyed on.
          const ids = found.labels.map((l) => l.recordId);
          const byId = new Map<string, DataRecord>();
          if (ids.length > 0) {
            const fetched = await databaseAdapter.query({
              filters: [
                { field: "id", operator: "in", value: ids },
                { field: "deletedAt", operator: "isNull" },
              ],
              // Combinable with the label filter, per the plan: "which
              // rendition of *this* record" is one query, not a label scan
              // followed by a client-side parent check.
              where: plan.query.where,
              limit: ids.length,
              ...(plan.query.excludeLabel ? { excludeLabel: plan.query.excludeLabel } : {}),
            });
            for (const r of fetched.records) byId.set(r.id, r);
          }
          // A label whose record is gone (a delete that raced sync) drops out
          // here. That is the one thing that can still short a page, and it is
          // why the contract is "page until nextCursor is null" rather than
          // "a short page means the end". `parentId` and `notLabel` short a
          // page the same way when combined with `label`, for the same reason
          // and with the same remedy.
          readable = ids.map((id) => byId.get(id)).filter((r): r is DataRecord => !!r);
          pageHasMore = found.hasMore;
          pageCursor = found.nextCursor;
        } else {
          const result = await databaseAdapter.query(plan.query);
          readable = result.records;
          pageHasMore = result.hasMore;
          pageCursor = result.nextCursor;
        }

        // When enrichment is requested, batch-read per-category metadata for the
        // page (one call per represented category) and index it by record id.
        const metadataById = new Map<string, MetadataRow>();
        if (includeMetadata) {
          const idsByCategory = new Map<string, StarkeepId[]>();
          for (const r of readable) {
            const category = typeCategory(r.type);
            if (category === "other") continue; // no metadata table
            let ids = idsByCategory.get(category);
            if (!ids) idsByCategory.set(category, (ids = []));
            ids.push(r.id);
          }
          for (const [category, ids] of idsByCategory) {
            for (const [id, row] of await databaseAdapter.getMetadataByIds(category, ids)) {
              metadataById.set(id, row);
            }
          }
        }

        // Availability, as *this node* sees it. The same record is instant
        // here and archived in the cloud, and both answers are correct —
        // which is why it is reported by whichever server was asked rather
        // than stored on the record.
        //
        // Locally the answer is nearly always instant: bytes on a disk are
        // readable or they are not here. The one interesting case is `absent`,
        // which is what an elided record looks like — metadata present, blob
        // deliberately declined — and a client that cannot tell that apart
        // from "readable" will render a broken image instead of an explanation.
        const availabilityByRecord = new Map<string, RecordAvailability>();
        if (readable.length > 0) {
          const storedAvailability = await databaseAdapter.getAvailability(
            readable.map((r) => r.objectStorageKey).filter(Boolean),
          );
          for (const r of readable) {
            const stored = storedAvailability.get(r.objectStorageKey);
            if (stored && stored.state !== "instant") {
              availabilityByRecord.set(
                r.id,
                stored.state === "archived"
                  ? {
                      state: "archived",
                      tier: stored.tier ?? "DEEP_ARCHIVE",
                      expectedLatencyHours: stored.expectedLatencyHours ?? 12,
                    }
                  : stored.state === "restoring"
                    ? {
                        state: "restoring",
                        readyAt:
                          stored.readyAtMs === null
                            ? null
                            : new Date(stored.readyAtMs).toISOString(),
                      }
                    : { state: "absent" },
              );
              continue;
            }
            // No stored row: fall back to whether the bytes are actually here.
            // One filesystem stat per record on a page is microseconds — the
            // reason the cloud cannot do this is that its equivalent is a
            // HeadObject per record, which is O(library) in network requests.
            const here = r.objectStorageKey
              ? await localAdapter.has(r.objectStorageKey)
              : false;
            availabilityByRecord.set(r.id, here ? { state: "instant" } : { state: "absent" });
          }
        }

        // The page's derived children, when asked for: every child carrying
        // the named label, with its dimensions. Generic over child records, a
        // label key and the width/height columns, so this server never learns
        // what any particular derived kind is.
        const candidatesById =
          variantLabel
            ? await loadVariantCandidatesForPage(databaseAdapter, readable, variantLabel)
            : null;
        const candidateAvailability = new Map<string, boolean>();
        if (candidatesById) {
          await Promise.all(
            [...candidatesById.values()].flat().map(async (candidate) => {
              candidateAvailability.set(
                candidate.id,
                await localAdapter.has(candidate.objectStorageKey),
              );
            }),
          );
        }

        // Label hydration: one batched primary-key-prefix seek for the whole
        // page, the same shape `include=metadata` uses.
        //
        // Not gated per namespace: any app that can read the record's type
        // sees every app's labels on it. That is the read model — labels are
        // assertions offered to other apps, and hiding who said what would
        // defeat the point.
        const labelsById = new Map<string, RecordLabel[]>();
        if (includeLabels && readable.length > 0) {
          const wantedApps = labelApps
            ? new Set(labelApps.split(",").map((s) => s.trim()).filter(Boolean))
            : null;
          for (const [id, labels] of await databaseAdapter.getLabelsByRecordIds(
            readable.map((r) => r.id),
          )) {
            labelsById.set(
              id,
              wantedApps ? labels.filter((l) => wantedApps.has(l.appId)) : labels,
            );
          }
        }

        // Each original's sizes, and where each sits on this node. Always
        // present on an original in a stand-in category: the listing collapses
        // stand-ins into their original, so this is the only place a reader
        // learns which sizes exist without a second query.
        const standInSummaries = await loadStandInSummariesForPage(
          databaseAdapter,
          readable,
          DEFAULT_STAND_IN_STANDARDS,
          localPlacementOf,
        );

        const records = await Promise.all(
          readable.map(async r => ({
            id: r.id,
            kind: r.kind,
            type: r.type,
            category: typeCategory(r.type),
            // Immutable provenance: which app created the record. Surfaced so
            // the Drive UI can show "this came from photos" even when photos
            // isn't cloud-installed.
            origin_app_id: r.originAppId,
            created_at: new Date(r.createdAt.wallTime).toISOString(),
            updated_at: new Date(r.updatedAt.wallTime).toISOString(),
            version: r.version,
            content_hash: r.contentHash,
            object_storage_key: r.objectStorageKey,
            mime_type: r.mimeType,
            size_bytes: r.sizeBytes,
            original_filename: r.originalFilename,
            parent_id: r.parentId,
            stand_in_role: r.standInRole,
            fidelity: r.fidelity,
            canonical_threshold: r.canonicalThreshold,
            self_canonical: r.selfCanonical,
            availability: availabilityByRecord.get(r.id) ?? { state: "instant" },
            path: r.objectStorageKey
              ? await localAdapter.resolvePath(r.objectStorageKey)
              : null,
            // `null` = enrichment requested but no metadata row (e.g. bytes
            // ingested by the folder watcher, which doesn't extract metadata).
            ...(includeMetadata ? { metadata: metadataById.get(r.id) ?? null } : {}),
            // `[]` rather than null when a record has none: absence of labels
            // is an empty set, not an unknown, which is the opposite of the
            // metadata case above (no metadata row = genuinely not extracted).
            ...(includeLabels
              ? {
                  labels: (labelsById.get(r.id) ?? []).map((l) => ({
                    app_id: l.appId,
                    key: l.key,
                    value: l.value,
                    // Wire/UI rendering only — storage has no such string.
                    label: `${l.appId}/${l.key}`,
                  })),
                }
              : {}),
            ...(standInSummaries.has(r.id)
              ? {
                  stand_ins: await renderStandInSummary(
                    standInSummaries.get(r.id)!,
                    plan.includeStandInUrls ? localStandInUrl : undefined,
                  ),
                }
              : {}),
            // Candidates with no stored dimensions are dropped rather than
            // sent with nulls: they cannot be ordered, so there is nothing a
            // caller could do with one.
            ...(candidatesById
              ? {
                  variant_candidates: (candidatesById.get(r.id) ?? [])
                    .filter((v) => (v.width ?? 0) > 0 && (v.height ?? 0) > 0)
                    .map((v) => ({
                      id: v.id,
                      type: v.type,
                      label_value: v.labelValue,
                      object_storage_key: v.objectStorageKey,
                      width: v.width,
                      height: v.height,
                      long_edge: Math.max(v.width!, v.height!),
                      available_here: candidateAvailability.get(v.id) ?? false,
                      ...(candidateAvailability.get(v.id)
                        ? {
                            url: `http://127.0.0.1:${PORT}/data/files/${createFileToken(
                              v.objectStorageKey,
                              v.type,
                              VARIANT_URL_TTL_SECONDS,
                            )}`,
                            url_lifetime: {
                              kind: "expires",
                              expires_at: new Date(Date.now() + VARIANT_URL_TTL_SECONDS * 1000).toISOString(),
                            },
                          }
                        : {}),
                    }))
                    .sort((a, b) => a.long_edge - b.long_edge),
                }
              : {}),
          })),
        );

        json(res, { records, hasMore: pageHasMore, nextCursor: pageCursor });
        return;
      }

      // POST /data/records — create a record from a file.
      // Two body shapes (in preference order):
      //   key-ref:  { type, contentType, contentHash, sizeBytes, fileName?, parentId?, labels? }
      //             Bytes already PUT via the presigned upload URL. Server
      //             verifies the blob is at shared/<type>/<shard>/<hash>.
      //             The path that scales to large files.
      //   filePath: { type, contentType, filePath, fileName?, parentId?, labels? }
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
          labels,
          metadata,
          standIn,
          parentFidelity,
          fidelity,
        } = JSON.parse(body) as {
          type?: string;
          fileName?: string;
          contentType?: string;
          filePath?: string;
          contentHash?: string;
          sizeBytes?: number;
          parentId?: StarkeepId;
          labels?: Array<{ key: string; value?: string }>;
          metadata?: Record<string, unknown>;
          /** `{ role, fidelity }` when this record is a stand-in for `parentId`. */
          standIn?: unknown;
          /** A stand-in write's report of the original's fidelity. */
          parentFidelity?: unknown;
          /** An original's report of its own fidelity. */
          fidelity?: unknown;
        };
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
        // contentType is advisory MIME — optional. When omitted the record's
        // mime_type is stored null (the serving edge falls back to
        // application/octet-stream).

        if (!isKnownType(type)) {
          res.writeHead(400);
          json(res, { error: `Unknown type id: ${type}` });
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

        // Optional inline metadata, checked **before** anything is written so a
        // rejected payload leaves no record behind.
        //
        // Same grant and same column rules as POST /data/records/:id/metadata,
        // deliberately: an app that may not write image metadata through one
        // door may not write it through the other. The field closes the window
        // in which a record is visible to sync without its metadata; it does
        // not widen who may write it.
        //
        // The layering rule is unchanged. The platform declares *which* columns
        // a category has and validates against that declaration; it does not
        // extract, and must not learn how. Extraction stays with an app holding
        // a `metadataWrite` grant and a decoder for the format — which is why
        // the folder watcher, which has only a filename, still sends nothing
        // here.
        if (metadata !== undefined) {
          if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
            res.writeHead(400);
            json(res, { error: "metadata must be an object" });
            return;
          }
          const metadataCategory = typeCategory(type);
          if (!appCanWriteMetadataCategory(localDb, appId!, metadataCategory)) {
            res.writeHead(403);
            json(res, {
              error: "AccessDenied",
              detail: `app "${appId}" has no metadataWrite grant on category "${metadataCategory}"`,
            });
            return;
          }
          if (metadataCategory === "other") {
            res.writeHead(400);
            json(res, {
              error: `Category "other" has no metadata table — only mapped categories support metadata`,
            });
            return;
          }
          const checked = checkMetadataValues(metadataCategory as Category, metadata);
          if (!checked.ok) {
            res.writeHead(400);
            json(res, { error: checked.message });
            return;
          }
        }

        // Fidelity, checked before anything is written. A stand-in reports its
        // own in `standIn` and the original's in `parentFidelity`; an original
        // reports its own in `fidelity`. The two shapes do not mix, because a
        // top-level `fidelity` on a stand-in would be ambiguous about which
        // record it describes.
        const isStandInWrite = standIn !== undefined && standIn !== null;
        if (isStandInWrite && metadata !== undefined) {
          res.writeHead(400);
          json(res, { error: "StandInMetadata", detail: STAND_IN_METADATA_REFUSAL });
          return;
        }
        if (isStandInWrite && fidelity !== undefined) {
          res.writeHead(400);
          json(res, {
            error: "InvalidStandIn",
            code: "fidelity-on-stand-in",
            detail: "a stand-in reports its own fidelity in standIn.fidelity and the original's in parentFidelity",
          });
          return;
        }
        if (!isStandInWrite && parentFidelity !== undefined) {
          res.writeHead(400);
          json(res, {
            error: "InvalidFidelity",
            code: "parent-fidelity-without-stand-in",
            detail: "parentFidelity accompanies a stand-in; an original reports its own fidelity in fidelity",
          });
          return;
        }
        const originalFidelity = planOriginalFidelity({ type, parentId, fidelity });
        if (!originalFidelity.ok) {
          res.writeHead(originalFidelity.status);
          json(res, originalFidelity.body);
          return;
        }

        // Render a record into the API response shape. Used for both the
        // freshly-created and dedup-existing paths.
        const renderRecord = async (r: {
          id: string;
          type: string;
          createdAt: { wallTime: number };
          updatedAt: { wallTime: number };
          mimeType: string | null;
          sizeBytes: number;
          objectStorageKey: string | null;
          originalFilename: string | null;
          parentId: string | null;
          standInRole: string | null;
          fidelity: number | null;
          canonicalThreshold: number | null;
          selfCanonical: boolean;
        }) => ({
          id: r.id,
          type: r.type,
          created_at: new Date(r.createdAt.wallTime).toISOString(),
          updated_at: new Date(r.updatedAt.wallTime).toISOString(),
          mime_type: r.mimeType,
          size_bytes: r.sizeBytes,
          object_storage_key: r.objectStorageKey,
          original_filename: r.originalFilename,
          parent_id: r.parentId,
          stand_in_role: r.standInRole,
          fidelity: r.fidelity,
          canonical_threshold: r.canonicalThreshold,
          self_canonical: r.selfCanonical,
          path: r.objectStorageKey ? await localAdapter.resolvePath(r.objectStorageKey) : null,
        });

        // Duplicate check: (parent, filename, content) is unique among live
        // records. Same bytes under the same filename and the same parent →
        // return the existing record with deduped:true, matching the response
        // shape this endpoint already uses. Enforced at the DB layer too — this
        // pre-check turns the would-be unique-violation into an idempotent
        // success.
        //
        // The three fields are exactly the uniqueness key and exactly the id
        // rule in `identifiers/content-id.ts`, and the agreement is the point.
        // A check keyed on less than the index dedups records the store
        // considers distinct, and the caller is told `deduped: true` about a
        // row that is not its own: two originals sharing a filename each derive
        // a rendition of the same name, and the second one silently receives
        // the first one's record. A check keyed on more than the index leaves
        // registrations to fail at the index instead of succeeding here.
        //
        // Null parent and null filename are matched as values rather than
        // skipped, so a top-level record is deduped by the same rule as a
        // derived one instead of leaning on the index alone.
        //
        // One rule, not two. A second check on `(parent_id, content_hash)`
        // stood here, collapsing two names for one derived file under one
        // parent, and it is gone rather than kept: it asserted "one object key,
        // at most one live record", which this system does not have and cannot
        // be given here. Object keys are `shared/<category>/<shard>/<hash>` —
        // no parent, no filename — so two copies of one file under two names
        // already share an object, which is what allowing file copies *means*.
        // A rule enforcing that invariant among children only preserves a
        // fragment of a guarantee nothing can rely on, and pays for the
        // fragment with the same wrong answer this check was just fixed to stop
        // giving: a caller registering `md_x.jpg` handed back `sm_x.jpg` and
        // told it was a duplicate.
        if (contentHash && /^[a-f0-9]{64}$/.test(contentHash)) {
          const dup = await databaseAdapter.query({
            filters: [
              parentId
                ? { field: "parentId", operator: "eq", value: parentId }
                : { field: "parentId", operator: "isNull" },
              fileName
                ? { field: "originalFilename", operator: "eq", value: fileName }
                : { field: "originalFilename", operator: "isNull" },
              { field: "contentHash", operator: "eq", value: contentHash },
              { field: "deletedAt", operator: "isNull" },
            ],
            limit: 1,
          });
          const existing = dup.records[0];
          if (existing) {
            // Another app registered these bytes first. An original's reported
            // fidelity still lands, because "the app that writes the original
            // reports the value when it knows it" should not depend on who got
            // there first.
            const reconciled = reconcileReportedFidelity(existing, originalFidelity.fidelity);
            if (!reconciled.ok) {
              res.writeHead(reconciled.status);
              json(res, reconciled.body);
              return;
            }
            const current =
              reconciled.write !== null && !isStandInWrite
                ? await recordOriginalFidelity(
                    databaseAdapter,
                    existing,
                    reconciled.write,
                    clock,
                    stampFor(existing.type, DEFAULT_STAND_IN_STANDARDS, true),
                  )
                : existing;
            json(res, { record: await renderRecord(current), deduped: true });
            return;
          }
        }

        // A stand-in: check it against the standards and the original, and
        // record the original's fidelity if this write is the first to report
        // it. See `stand-ins/write.ts` in shared-space-api, which the cloud
        // calls too.
        let standInFields: { standInRole: "canonical" | "smaller"; fidelity: number } | null = null;
        if (isStandInWrite) {
          const plan = await planStandInWrite(
            databaseAdapter,
            appGrants(localDb, appId!),
            { type, parentId, standIn, parentFidelity, sizeBytes },
            DEFAULT_STAND_IN_STANDARDS,
            true,
          );
          if (!plan.ok) {
            res.writeHead(plan.status);
            json(res, plan.body);
            return;
          }
          const retired = await retireReplacedStandIns(databaseAdapter, plan, clock);
          if (plan.selfCanonical) {
            // The canonical encode could not shrink the original, so the
            // original stands in for itself and this stand-in is not stored.
            const original = await markSelfCanonical(databaseAdapter, plan, clock);
            changeNotifier.emit({
              eventType: "local-change-recorded",
              recordIds: [original.id, ...retired.map((r) => r.id)],
              timestamp: original.updatedAt,
            });
            json(res, { selfCanonical: true, original: await renderRecord(original) });
            return;
          }
          if (plan.recordParentFidelity !== null) {
            await recordOriginalFidelity(
              databaseAdapter,
              plan.parent,
              plan.recordParentFidelity,
              clock,
              plan.parentStamp,
            );
          }
          standInFields = { standInRole: plan.role, fidelity: plan.fidelity };
        }

        let record;
        const baseInput = {
          type,
          originAppId: appId!,
          parentId: parentId ?? null,
          ...(standInFields ?? {
            fidelity: originalFidelity.fidelity,
            // The threshold this original is judged by, stamped with the
            // fidelity that it judges. See `DataRecord.canonicalThreshold`.
            canonicalThreshold:
              originalFidelity.fidelity === null
                ? null
                : stampFor(type, DEFAULT_STAND_IN_STANDARDS, true),
          }),
          // Written by the SDK in the same call as the record row, so the
          // record is never visible to a sync scan without it. Not atomic —
          // see `DataPutInput.metadata` — but the window is a pair of adjacent
          // adapter calls rather than a pair of HTTP requests.
          ...(metadata ? { metadata } : {}),
        };
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
            if (standInFields && isStandInSlotConflict(err)) {
              // Another writer took the slot between the plan and the write.
              const occupant = await liveStandIn(
                databaseAdapter,
                parentId!,
                standInFields.standInRole,
                standInFields.standInRole === "smaller" ? standInFields.fidelity : undefined,
              );
              const conflict = standInExists(occupant?.id ?? "");
              res.writeHead(conflict.status);
              json(res, conflict.body);
              return;
            }
            throw err;
          }
        } else {
          // Reachable only when contentHash is absent, and the guard above
          // required one of the two, so filePath is present here.
          const localPath = filePath!;
          const resolvedName = fileName ?? localPath.split("/").pop() ?? localPath;
          try {
            record = await sdk.data.putWithLocalFile(
              { ...baseInput, originalFilename: resolvedName },
              localPath,
              contentType,
            );
          } catch (err) {
            if (isDuplicateFileError(err)) {
              res.writeHead(409);
              json(res, { error: "Duplicate file" });
              return;
            }
            if (standInFields && isStandInSlotConflict(err)) {
              // Another writer took the slot between the plan and the write.
              const occupant = await liveStandIn(
                databaseAdapter,
                parentId!,
                standInFields.standInRole,
                standInFields.standInRole === "smaller" ? standInFields.fidelity : undefined,
              );
              const conflict = standInExists(occupant?.id ?? "");
              res.writeHead(conflict.status);
              json(res, conflict.body);
              return;
            }
            throw err;
          }
        }

        // Optional labels, written in the same request as the record but
        // NOT in the same transaction. A reader can briefly see the record
        // without its labels.
        //
        // That is deliberate. Sync reintroduces the window regardless — the
        // label carries the higher HLC, so merged-order apply delivers the
        // record first at every peer however atomic the origin write was —
        // so a local transaction would close a millisecond and leave the
        // seconds-to-minutes case untouched. It also matches what metadata
        // already does, and does it better: metadata isn't even one request.
        if (Array.isArray(labels) && labels.length > 0) {
          const plan = await planLabelWriteBatch(
            appId!,
            labels.map((l) => ({ ...l, recordId: record.id })),
          );
          if (!plan.ok) {
            // The record is already written. Report the label failure rather
            // than pretending the whole call failed — the caller can retry
            // just the labels against POST /data/labels.
            res.writeHead(plan.status);
            json(res, {
              error: "InvalidLabelWrite",
              detail: plan.error,
              record: await renderRecord(record),
              recordCreated: true,
            });
            return;
          }
          const labelHlc = clock.now();
          await databaseAdapter.upsertLabels(
            plan.writes.map((w) => ({ ...w, appId: appId!, hlc: labelHlc })),
          );
        }

        // Cloud propagation happens via the sync engine, not from here. The
        // engine pushes record metadata through the per-app sync transport and
        // then uploads the blob via HttpObjectStorageAdapter against
        // /apps/<originAppId>/files, where the cloud-data-server assumes the
        // origin app's role to PUT into S3. That's the only path that
        // attributes the byte to its originating app, per
        // data-roles-and-permissions.md.

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
        // Returned for parity with the cloud broker so one client code path
        // works against either backend. The upload endpoint below independently
        // hashes the body and rejects a mismatch, so locally this is a
        // convenience rather than the enforcement — the enforcement is there,
        // and it predates this item. (Against S3 it is the other way round: the
        // pinned checksum *is* the enforcement, because the local server is not
        // in the byte path at all.)
        const contentHash = contentHashFromDataRecordObjectKey(body.key);
        json(res, {
          url: `http://127.0.0.1:${PORT}/data/files/upload/${token}`,
          ...(contentHash ? { checksumSha256: sha256HexToBase64(contentHash) } : {}),
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
        // Shared-data keys are content-addressed (shared/<typeId>/<shard>/<hash>),
        // so verify the body actually hashes to the expected key — otherwise the
        // caller is trying to write mismatched bytes under a fixed name. App-data
        // keys (apps/<appId>/syncable/<subKey>) are *not* content-addressed (the
        // subKey is a stable app-chosen name), so the hash check doesn't apply;
        // the signed token already authorizes that exact key.
        if (parsed.key.startsWith("shared/")) {
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
        // Bytes land at shared/<category>/…, so authorize the derived category.
        // Accept a full Starkeep type id or a bare category id; reject anything
        // else rather than letting typeCategory's "other" fallback coerce a typo.
        if (!isKnownType(typeId) && !isCategoryId(typeId)) {
          res.writeHead(400);
          json(res, { error: `Unknown type id: ${typeId}` });
          return;
        }
        const fileCategory = typeCategory(typeId);
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
            // GET /app-data/db/<table> — the query grammar.
            //
            // Every top-level parameter name is reserved, which is what lets
            // the filters live under `where` with no sigil. The parser is
            // shared with the cloud handler, so the two cannot drift the way
            // the hand-written grammars did: this one defaulted to limit=100
            // with no cap while the cloud one defaulted to 50 capped at 500.
            if (req.method === "GET") {
              const result = await view.query(table, queryParamsFrom(url.searchParams));
              json(res, result.mode === "rows"
                ? { rows: result.rows, truncated: result.truncated, page_token: result.pageToken }
                : { groups: result.groups, truncated: result.truncated });
              return;
            }
          } catch (err) {
            res.writeHead(400);
            json(res, { error: err instanceof Error ? err.message : String(err) });
            return;
          }
        }

        // POST /app-data/files/presign — issue an upload-token URL for an
        // app-private file, mirroring /files/presign so a single client code
        // path works against either backend. The key is built server-side from
        // appId + subKey. After uploading, the client calls .../record below.
        if (path === "/app-data/files/presign" && req.method === "POST") {
          try {
            const body = JSON.parse(await readBody(req)) as {
              subKey?: string;
              contentType?: string;
              expiresIn?: number;
            };
            if (!body.subKey) {
              res.writeHead(400);
              json(res, { error: "subKey is required" });
              return;
            }
            // statFile enforces filesEnabled before we mint an upload token.
            await view.statFile(body.subKey);
            const key = appSyncableObjectKey(appId!, body.subKey);
            const mimeType = body.contentType ?? "application/octet-stream";
            const token = createUploadToken(key, mimeType, body.expiresIn ?? 3600);
            json(res, {
              url: `http://127.0.0.1:${PORT}/data/files/upload/${token}`,
              key,
            });
            return;
          } catch (err) {
            res.writeHead(400);
            json(res, { error: err instanceof Error ? err.message : String(err) });
            return;
          }
        }

        // POST /app-data/files/<subKey>/record — register a file uploaded
        // out-of-band via the presign flow, writing the index row without the
        // server holding the bytes.
        const fileRecordMatch = path.match(/^\/app-data\/files\/(.+)\/record$/);
        if (fileRecordMatch && req.method === "POST") {
          const subKey = decodeURIComponent(fileRecordMatch[1]!);
          try {
            const body = JSON.parse(await readBody(req)) as {
              contentHash?: string;
              mimeType?: string;
              sizeBytes?: number;
              originalFilename?: string | null;
            };
            if (!body.contentHash || !body.mimeType || typeof body.sizeBytes !== "number") {
              res.writeHead(400);
              json(res, { error: "contentHash, mimeType, and sizeBytes are required" });
              return;
            }
            const result = await view.registerFile(subKey, {
              contentHash: body.contentHash,
              mimeType: body.mimeType,
              sizeBytes: body.sizeBytes,
              originalFilename: body.originalFilename ?? null,
            });
            json(res, result);
            return;
          } catch (err) {
            res.writeHead(400);
            json(res, { error: err instanceof Error ? err.message : String(err) });
            return;
          }
        }

        // POST /app-data/file-urls — batch of playback URLs for app-private
        // files. Body: { subKeys: string[], expiresIn? }. Per-subKey semantics
        // match GET /app-data/files/<subKey>, except that a subKey with no live
        // index row is omitted from the response instead of failing the batch,
        // which mirrors /data/records/file-urls on the shared plane.
        //
        // Exists because the per-file shape costs one request per file, and a
        // client that needs N of them at once — a study screen prefetching the
        // next few cards' audio, a gallery opening — spends N round trips to
        // learn N URLs. In the cloud each of those is a Lambda invocation on
        // the app's proxy *and* one here, so a six-file prefetch demands twelve
        // concurrent slots. That is what silently dropped memo's study audio.
        //
        // A subKey the app may not address (files not enabled, wrong prefix)
        // still fails the whole request: "this file does not exist" is a
        // per-item outcome, but "you may not ask that" is a caller error and
        // hiding it inside a partial result would make it unfindable.
        if (path === "/app-data/file-urls" && req.method === "POST") {
          try {
            const body = JSON.parse(await readBody(req)) as {
              subKeys?: unknown;
              expiresIn?: unknown;
            };
            if (
              !Array.isArray(body.subKeys) ||
              body.subKeys.length === 0 ||
              !body.subKeys.every((k) => typeof k === "string" && k.length > 0)
            ) {
              res.writeHead(400);
              json(res, { error: "subKeys must be a non-empty array of strings" });
              return;
            }
            if (body.subKeys.length > 200) {
              res.writeHead(400);
              json(res, { error: "subKeys must contain at most 200 entries" });
              return;
            }
            const expiresIn =
              typeof body.expiresIn === "number" &&
              Number.isFinite(body.expiresIn) &&
              body.expiresIn > 0
                ? body.expiresIn
                : 3600;
            const urls: Record<string, string> = {};
            for (const subKey of new Set(body.subKeys as string[])) {
              const fileUrl = await view.fileUrl(subKey, { expiresIn });
              if (fileUrl) urls[subKey] = fileUrl;
            }
            json(res, { urls, expiresIn });
            return;
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
            // Writes go through the presign + /record flow above — there is no
            // body-through PUT on the app-data file plane.
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

      // POST /data/records/file-urls — batch of time-limited file URLs.
      // Per-id semantics mirror the single file-url route below (local token
      // URL when the bytes are on disk, remote signed URL otherwise), except
      // that unknown, unreadable, and unresolvable ids are omitted from the
      // response instead of failing the whole batch. Exists so gallery-style
      // clients can resolve N URLs in one request instead of N.
      if (path === "/data/records/file-urls" && req.method === "POST") {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as { ids?: unknown; expiresIn?: unknown };
        if (
          !Array.isArray(parsed.ids) ||
          parsed.ids.length === 0 ||
          !parsed.ids.every((id) => typeof id === "string" && id.length > 0)
        ) {
          res.writeHead(400);
          json(res, { error: "ids must be a non-empty array of record ids" });
          return;
        }
        if (parsed.ids.length > 500) {
          res.writeHead(400);
          json(res, { error: "ids must contain at most 500 record ids" });
          return;
        }
        const expiresIn =
          typeof parsed.expiresIn === "number" && Number.isFinite(parsed.expiresIn) && parsed.expiresIn > 0
            ? parsed.expiresIn
            : 3600;
        const urls: Record<string, { url: string; mimeType?: string | null; sizeBytes?: number | null }> = {};
        const readable: AnyRecord[] = [];
        for (const id of new Set(parsed.ids)) {
          const record = await sdk.data.get(createStarkeepId(id));
          if (!record?.objectStorageKey) continue;
          if (!appCanRead(localDb, appId!, record.type)) continue;
          readable.push(record);
        }
        // Missing bytes arrive through the Drive channel, a few at a time, so
        // one batch cannot open hundreds of transfers at once. An id whose
        // fetch fails is omitted, like any other unresolvable id.
        await forEachBounded(readable, FILE_URL_FETCH_CONCURRENCY, async (record) => {
          if (!(await ensureLocalBytes(record))) return;
          const mimeType = record.mimeType ?? "application/octet-stream";
          const token = createFileToken(record.objectStorageKey!, mimeType, expiresIn);
          urls[record.id] = {
            url: `http://127.0.0.1:${PORT}/data/files/${token}`,
            mimeType: record.mimeType,
            sizeBytes: record.sizeBytes,
          };
        });
        json(res, { urls, expiresIn });
        return;
      }

      // GET /data/stand-ins/backlog?kind=missing-canonical|missing-fidelity
      //
      // Originals waiting on an app: those that take a canonical stand-in and
      // have none, and those nobody has reported a fidelity for. Apps read it
      // to find work; nothing here asks the platform to do any. Restricted to
      // the caller's readable types, and paged — a page can come back short,
      // so page until nextCursor is null.
      if (path === "/data/stand-ins/backlog" && req.method === "GET") {
        const kind = url.searchParams.get("kind") ?? "missing-canonical";
        if (!(BACKLOG_KINDS as readonly string[]).includes(kind)) {
          res.writeHead(400);
          json(res, { error: `kind must be one of ${BACKLOG_KINDS.join(", ")}` });
          return;
        }
        const limit = Number(url.searchParams.get("limit") ?? "100");
        const cursor = url.searchParams.get("page_token") ?? undefined;
        const page = await pageBacklog(
          databaseAdapter,
          appGrants(localDb, appId!),
          { kind: kind as BacklogKind, limit: Number.isFinite(limit) ? limit : 100, ...(cursor ? { cursor } : {}) },
          DEFAULT_STAND_IN_STANDARDS,
        );
        json(res, {
          kind,
          records: page.records.map((r) => ({
            id: r.id,
            type: r.type,
            fidelity: r.fidelity,
            canonical_threshold: r.canonicalThreshold,
            self_canonical: r.selfCanonical,
            size_bytes: r.sizeBytes,
            original_filename: r.originalFilename,
          })),
          nextCursor: page.nextCursor,
        });
        return;
      }

      // GET /data/records/:id/content-url?size=<n|canonical> — the content read
      // at a chosen size.
      //
      // Names the file actually served, because a listing describes the
      // original and a read at a size usually answers with a stand-in in
      // another format: a HEIC original yields AVIF stand-ins, and an app that
      // took the content type from the listing would label AVIF bytes as HEIC.
      // A missing standard size is a 404 carrying the summary, so the app can
      // choose its own fallback; this never substitutes a far larger file.
      const contentUrlMatch = path.match(/^\/data\/records\/([^/]+)\/content-url$/);
      if (contentUrlMatch && req.method === "GET") {
        const outcome = await resolveContentRead(
          databaseAdapter,
          appGrants(localDb, appId!),
          decodeURIComponent(contentUrlMatch[1]!),
          url.searchParams.get("size"),
          DEFAULT_STAND_IN_STANDARDS,
          localPlacementOf,
        );
        if (!outcome.ok) {
          res.writeHead(outcome.status);
          json(res, outcome.body);
          return;
        }
        const { size } = outcome;
        const served = size.recordId === outcome.original.id
          ? outcome.original
          : await databaseAdapter.get(size.recordId as StarkeepId);
        if (!served || !served.objectStorageKey) {
          res.writeHead(404);
          json(res, { error: "NotFound", detail: "the record that answers this size has no file" });
          return;
        }
        const expiresIn = parseInt(url.searchParams.get("expiresIn") || "3600", 10);
        const availableHere = await ensureLocalBytes(served);
        const fileUrl = availableHere
          ? `http://127.0.0.1:${PORT}/data/files/${createFileToken(
              served.objectStorageKey,
              served.mimeType ?? mimeForStandIn(served.type),
              expiresIn,
            )}`
          : null;
        json(res, {
          record_id: served.id,
          type: served.type,
          mime_type: served.mimeType ?? mimeForStandIn(served.type),
          fidelity: size.fidelity,
          role: size.role,
          size_bytes: served.sizeBytes,
          available_here: availableHere,
          url: fileUrl,
          expires_in: expiresIn,
        });
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
        // Before any fetch: a read of bytes this node lacks downloads them, so
        // an app without the grant must not reach even the download.
        if (!appCanRead(localDb, appId!, record.type)) {
          res.writeHead(403);
          json(res, { error: "Forbidden" });
          return;
        }
        if (!record.objectStorageKey) {
          res.writeHead(404);
          json(res, { error: "Record has no attached file" });
          return;
        }
        const expiresIn = parseInt(url.searchParams.get("expiresIn") || "3600", 10);
        const mimeType = record.mimeType ?? "application/octet-stream";

        if (await ensureLocalBytes(record)) {
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

        if (!supervisor) {
          res.writeHead(404);
          json(res, { error: "File not on this node, and this node does not sync with a cloud" });
          return;
        }
        res.writeHead(502);
        json(res, { error: "File not on this node, and the fetch from the cloud failed" });
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
        // stat() rather than get(): the old code read the entire object into
        // memory to serve it, which is unremarkable for a 3 MB still and an
        // outright OOM for a 4 GB clip — one allocation of the whole file per
        // concurrent request.
        const facts = await localAdapter.stat(parsed.key);
        if (!facts) {
          res.writeHead(404);
          json(res, { error: "File not found" });
          return;
        }

        const parsedRange = parseRangeHeader(req.headers["range"], facts.sizeBytes);
        if (parsedRange === "unsatisfiable") {
          // 416 must carry the real length, which is how a client that guessed
          // past the end learns what to ask for instead.
          res.writeHead(416, {
            "Content-Range": `bytes */${facts.sizeBytes}`,
            "Accept-Ranges": "bytes",
          });
          res.end();
          return;
        }

        const stream = await localAdapter.getStream(parsed.key, parsedRange ?? undefined);
        if (!stream) {
          res.writeHead(404);
          json(res, { error: "File not found" });
          return;
        }

        // `Accept-Ranges` is advertised on every response, not just ranged
        // ones: a <video> element reads it from the first response to decide
        // whether seeking is possible at all, and without it the browser
        // disables the scrub bar even though ranges would have worked.
        const headers: Record<string, string | number> = {
          "Content-Type": parsed.mimeType,
          "Accept-Ranges": "bytes",
          // Cached, and `immutable` is a statement of fact rather than
          // optimism: object keys are content-addressed — a `shared/` key is
          // verified to equal the SHA of its bytes — so what is behind a key
          // genuinely cannot change, and a respecified rendition is a new
          // record with a new key rather than an overwrite.
          //
          // `private` because these are one person's photos and no shared cache
          // has any business holding them. The bytes are on this machine's disk
          // already, which is where the server is reading them from, so a
          // browser cache copy grants nothing the holder did not have.
          //
          // The max-age is the token's own remaining life, so a response is
          // never cached past the point its URL stops working. Within a bucket
          // the first request sees the largest remaining life and it is that
          // response the browser stores, which is exactly right.
          "Cache-Control": `private, max-age=${cacheSecondsFor(parsed.expires)}, immutable`,
        };
        if (parsedRange) {
          const end = parsedRange.end ?? facts.sizeBytes - 1;
          headers["Content-Range"] = `bytes ${parsedRange.start}-${end}/${facts.sizeBytes}`;
          headers["Content-Length"] = end - parsedRange.start + 1;
        } else {
          headers["Content-Length"] = facts.sizeBytes;
        }
        res.writeHead(parsedRange ? 206 : 200, headers);
        try {
          await pipeline(Readable.fromWeb(stream as never), res);
        } catch (err) {
          // A viewer that scrolls a tile out of view, or a <video> element that
          // seeks, aborts the request mid-body. `pipeline` reports that as an
          // error, but nothing went wrong here: the bytes the peer wanted are
          // the bytes it got. Anything else still propagates.
          if (!isPeerGoneError(err)) throw err;
          console.debug("File stream aborted by peer:", parsed.key);
        }
        return;
      }

      // GET /data/label-keys[?app=<appId>] — the manifest-declared label-key
      // registry.
      //
      // Deliberately NOT filtered by the caller's grants: which keys an app
      // declares is public schema, not user data. Discoverability across apps
      // is the whole reason keys are declared in a manifest rather than
      // counted at runtime — app B's developer (and app B's code) has to be
      // able to enumerate what app A publishes.
      // GET /residency/stand-ins — this node's sync-down ceilings, and what it
      // holds against them.
      //
      // Operator information about this node: the ceiling per stand-in
      // category, where it came from, and the desktop defaults so an editor
      // can mark them.
      if (path === "/residency/stand-ins" && req.method === "GET") {
        const usage = residencyManager.usageByGroup();
        // The operator's view of the backlog, across every type: why storage
        // costs have not dropped yet, and which originals no app has measured.
        const everything = buildAccessGrants([], { allAccess: true });
        const backlog = Object.fromEntries(
          await Promise.all(
            BACKLOG_KINDS.map(
              async (kind) =>
                [kind, await countBacklog(databaseAdapter, everything, kind, DEFAULT_STAND_IN_STANDARDS)] as const,
            ),
          ),
        );
        json(res, {
          ceilings,
          configured: starkeepConfig.standInCeilings ?? {},
          keepOriginals: starkeepConfig.keepOriginals === true,
          libraryOriginals: originalBytesByCategory(localDb),
          defaults: DEFAULT_SYNC_DOWN_CEILINGS.desktop,
          standardSizes: Object.fromEntries(
            STAND_IN_CATEGORIES.map((c) => [c, DEFAULT_STAND_IN_STANDARDS[c].standardSizes]),
          ),
          canonicalThresholds: Object.fromEntries(
            STAND_IN_CATEGORIES.map((c) => [c, DEFAULT_STAND_IN_STANDARDS[c].canonicalThreshold]),
          ),
          heldBytes: Object.fromEntries(
            STAND_IN_CATEGORIES.map((c) => [
              c,
              {
                originals: usage[`original:${c}`] ?? 0,
                standIns: usage[`stand-in:${c}`] ?? 0,
              },
            ]),
          ),
          backlog,
        });
        return;
      }

      // PUT /residency/stand-ins — change this node's ceilings, and whether it
      // keeps every original.
      //
      // Validated, saved, and applied by restart: the residency manager is
      // built from config at boot. A raised ceiling reaches files earlier
      // rounds declined through the catalogue scan the restart runs and the
      // acquisition pass after each Drive-channel drain.
      if (path === "/residency/stand-ins" && req.method === "PUT") {
        const body = JSON.parse(await readBody(req)) as {
          ceilings?: Record<string, unknown>;
          keepOriginals?: unknown;
        };
        const problems = ceilingProblems(body);
        if (problems.length > 0) {
          res.writeHead(422);
          json(res, { error: "ceilings are not valid", problems });
          return;
        }
        const patch: Partial<StarkeepConfig> = {
          ...(body.ceilings ? { standInCeilings: body.ceilings as StarkeepConfig["standInCeilings"] } : {}),
          ...(typeof body.keepOriginals === "boolean" ? { keepOriginals: body.keepOriginals } : {}),
        };
        const updated: StarkeepConfig = { ...starkeepConfig, ...patch };
        await writeFile(STARKEEP_CONFIG_PATH, JSON.stringify(updated, null, 2), "utf8");
        Object.assign(starkeepConfig, patch);
        json(res, {
          ok: true,
          ceilings: resolveCeilings(updated),
          keepOriginals: updated.keepOriginals === true,
        });
        setTimeout(restartProcess, 200);
        return;
      }

      // POST /residency/free-up-space — the person's "Free up space".
      //
      // Body: { bytes, scope: "originals" | "originals-and-above-ceiling",
      // dryRun? }. Removes originals — and, in the wider scope, stand-ins above
      // this node's ceiling — largest first until `bytes` are free, each only
      // after proving complete cloud copies of it, its original and the
      // original's canonical stand-in. Nothing else on this node removes a
      // file. A dry run proves and totals without
      // removing, which is the estimate the person confirms.
      if (path === "/residency/free-up-space" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          bytes?: unknown;
          scope?: unknown;
          dryRun?: unknown;
        };
        if (typeof body.bytes !== "number" || !Number.isFinite(body.bytes) || body.bytes < 0) {
          res.writeHead(400);
          json(res, { error: "bytes must be a non-negative number" });
          return;
        }
        if (body.scope !== "originals" && body.scope !== "originals-and-above-ceiling") {
          res.writeHead(400);
          json(res, { error: 'scope must be "originals" or "originals-and-above-ceiling"' });
          return;
        }
        const probe = supervisor?.cloudReplicaProbe() ?? null;
        const report = await residencyManager.freeUpSpace({
          bytes: body.bytes,
          scope: body.scope,
          probes: probe ? [probe] : [],
          dryRun: body.dryRun === true,
        });
        json(res, { ...report, cloudReachable: probe !== null });
        return;
      }

      if (path === "/data/label-keys" && req.method === "GET") {
        const filterApp = url.searchParams.get("app");
        let q = qb
          .selectFrom("shared_app_label_keys")
          .select(["app_id", "key", "description"])
          .orderBy("app_id", "asc")
          .orderBy("key", "asc");
        if (filterApp) q = q.where("app_id", "=", filterApp);
        const compiled = q.compile();
        const rows = localDb
          .prepare(compiled.sql)
          .all(...(compiled.parameters as string[])) as Array<{
          app_id: string;
          key: string;
          description: string | null;
        }>;
        json(res, {
          labelKeys: rows.map((r) => ({
            app_id: r.app_id,
            key: r.key,
            // The wire/UI rendering. Storage has no such string — app_id is a
            // column — but this is what a human reads.
            label: `${r.app_id}/${r.key}`,
            description: r.description,
          })),
        });
        return;
      }

      // POST /data/labels — add labels (insert-or-update).
      // Body: { labels: [{ recordId, key, value? }, …] }
      //
      // Adds; does not replace. A key is set-valued, so writing `faces=Bob`
      // where `faces=Alice` already sits leaves both — POST /data/labels/values
      // is the endpoint that makes a key hold exactly a given set.
      //
      // `appId` is never in the body: it is the authenticated subject, which
      // is what makes squatting another app's namespace unrepresentable rather
      // than merely rejected.
      if (path === "/data/labels" && req.method === "POST") {
        const body = JSON.parse(await readBody(req)) as {
          labels?: Array<{ recordId?: string; key?: string; value?: string }>;
        };
        const entries = body.labels;
        if (!Array.isArray(entries) || entries.length === 0) {
          res.writeHead(400);
          json(res, { error: "labels must be a non-empty array" });
          return;
        }
        if (entries.some((e) => !e.recordId || !e.key)) {
          res.writeHead(400);
          json(res, { error: "each label needs a recordId and a key" });
          return;
        }

        const plan = await planLabelWriteBatch(
          appId!,
          entries as Array<{ recordId: StarkeepId; key: string; value?: string }>,
        );
        if (!plan.ok) {
          res.writeHead(plan.status);
          json(res, { error: "InvalidLabelWrite", detail: plan.error });
          return;
        }

        const hlc = clock.now();
        await databaseAdapter.upsertLabels(
          plan.writes.map((w) => ({ ...w, appId: appId!, hlc })),
        );
        // Nudges the Drive channel with the affected records. Note this does
        // NOT touch records.updated_at — a label write that did would re-ship
        // the whole record and disturb every peer's watermark.
        changeNotifier.emit({
          eventType: "local-change-recorded",
          recordIds: plan.writes.map((w) => w.recordId),
          timestamp: hlc,
          // originAppId is left unset on purpose: labels are shared data, so
          // the always-on Drive channel owns them, not the writing app's.
        });
        json(res, { written: plan.writes.length });
        return;
      }

      // POST /data/labels/values — make each key hold exactly `values`.
      // Body: { labels: [{ recordId, key, values: [...] }, …] }
      //
      // The set-valued write. Upserts the listed values and tombstones the rest
      // of that key's values on that record, atomically per entry — the diff an
      // app would otherwise have to compute itself, non-atomically, from a read
      // it would have to do first. An empty `values` clears the key.
      //
      // This is what a **single-valued** key uses to update: since `value`
      // joined the primary key, POST /data/labels no longer overwrites, so
      // "set the count to 4" written as a plain add leaves `count=3` beside it.
      if (path === "/data/labels/values" && req.method === "POST") {
        const body = JSON.parse(await readBody(req)) as {
          labels?: Array<{ recordId?: string; key?: string; values?: unknown }>;
        };
        const entries = body.labels;
        if (!Array.isArray(entries) || entries.length === 0) {
          res.writeHead(400);
          json(res, { error: "labels must be a non-empty array" });
          return;
        }
        if (
          entries.some(
            (e) =>
              !e.recordId ||
              !e.key ||
              !Array.isArray(e.values) ||
              e.values.some((v) => typeof v !== "string"),
          )
        ) {
          res.writeHead(400);
          json(res, {
            error: "each entry needs a recordId, a key, and a values array of strings",
          });
          return;
        }
        const normalized = entries.map((e) => ({
          recordId: e.recordId as StarkeepId,
          key: e.key as string,
          // Deduped here: the upsert half is one multi-row statement and cannot
          // touch a row twice on DSQL, and a repeat is the same row anyway.
          values: [...new Set(e.values as string[])],
        }));

        // An entry with no values writes nothing — it only tombstones — so it
        // is a retraction of the whole key and is gated as one: no declared-key
        // check (an uninstalled key's rows must stay reachable by their author)
        // and no record-existence check (clearing a key on a deleted record is
        // a no-op). Sending it through the write gate would be the bug
        // planLabelRetractions exists to avoid.
        const clears = normalized.filter((e) => e.values.length === 0);
        const sets = normalized.filter((e) => e.values.length > 0);

        const clearPlan = planLabelRetractions(clears);
        if (!clearPlan.ok) {
          res.writeHead(clearPlan.status);
          json(res, { error: "InvalidLabelRetraction", detail: clearPlan.error });
          return;
        }

        // The rest is gated exactly like an add — same key shape, same
        // declared-key check, same record-existence check, same read grant, same
        // value-cardinality cap.
        const plan = await planLabelWriteBatch(
          appId!,
          sets.flatMap((e) =>
            e.values.map((value) => ({ recordId: e.recordId, key: e.key, value })),
          ),
        );
        if (!plan.ok) {
          res.writeHead(plan.status);
          json(res, { error: "InvalidLabelWrite", detail: plan.error });
          return;
        }

        const typeByRecord = new Map(plan.writes.map((w) => [w.recordId, w.recordType]));
        const hlc = clock.now();
        await databaseAdapter.replaceLabelValues(
          sets.map((e) => ({
            recordId: e.recordId,
            appId: appId!,
            key: e.key,
            values: e.values,
            recordType: typeByRecord.get(e.recordId)!,
            hlc,
          })),
        );
        // Omitted `value` — retract every value of the key, which is what an
        // empty `values` asked for.
        await databaseAdapter.retractLabels(
          clearPlan.writes.map((e) => ({
            recordId: e.recordId,
            key: e.key,
            appId: appId!,
            hlc,
          })),
        );
        changeNotifier.emit({
          eventType: "local-change-recorded",
          recordIds: normalized.map((e) => e.recordId),
          timestamp: hlc,
        });
        json(res, { replaced: normalized.length });
        return;
      }

      // POST /data/labels/retract — tombstone labels.
      // Body: { labels: [{ recordId, key, value? }, …] }
      //
      // An omitted `value` retracts **every** value of that key on that record;
      // `value: ""` retracts the bare flag alone.
      if (path === "/data/labels/retract" && req.method === "POST") {
        const body = JSON.parse(await readBody(req)) as {
          labels?: Array<{ recordId?: string; key?: string; value?: string }>;
        };
        const entries = body.labels;
        if (!Array.isArray(entries) || entries.length === 0) {
          res.writeHead(400);
          json(res, { error: "labels must be a non-empty array" });
          return;
        }
        if (entries.some((e) => !e.recordId || !e.key)) {
          res.writeHead(400);
          json(res, { error: "each retraction needs a recordId and a key" });
          return;
        }

        // Checks far less than the write path — no declared-key check, no
        // record-existence check, no grant check. See planLabelRetractions.
        const plan = planLabelRetractions(
          entries as Array<{ recordId: StarkeepId; key: string; value?: string }>,
        );
        if (!plan.ok) {
          res.writeHead(plan.status);
          json(res, { error: "InvalidLabelRetraction", detail: plan.error });
          return;
        }

        const hlc = clock.now();
        await databaseAdapter.retractLabels(
          plan.writes.map((r) => ({ ...r, appId: appId!, hlc })),
        );
        changeNotifier.emit({
          eventType: "local-change-recorded",
          recordIds: plan.writes.map((r) => r.recordId),
          timestamp: hlc,
        });
        json(res, { retracted: plan.writes.length });
        return;
      }

      // POST /data/records/:id/metadata — write metadata for a record.
      // The app is responsible for extracting metadata values (e.g. EXIF from
      // image bytes); the server validates keys against the per-category schema
      // and persists. Requires metadataWrite on the record's own category.
      //
      // **The record's type decides everything: the grant, the column schema
      // and the table.** The body's `typeId` is read and ignored, exactly as
      // the read route below ignores its path segment, and for the same reason
      // — a caller-supplied discriminant lets a caller pick which table its
      // grant is checked against.
      //
      // Before this, the category came from the body and the table came from
      // the record, so the two could disagree. Two things followed. An app
      // holding `metadataWrite` on `image` and not on `video` could post
      // `typeId: "image"` against a video record and write every column the two
      // categories share — `width`, `captured_at`, `gps_lat`, `thumb_hash`.
      // And an honest mismatch reached the database as a raw column error:
      // Photos' viewer posting image metadata against a clip produced
      // `table shared_record_video_metadata has no column named exif_present`
      // as a 500, where it is a 400 about the caller's own request.
      // POST /data/records/:id/fidelity — report an existing original's
      // fidelity. Body: { fidelity }. Recorded once by the platform; a
      // disagreeing report answers 409. See `planFidelityReport` in
      // shared-space-api, which the cloud calls too.
      const fidelityMatch = path.match(/^\/data\/records\/([^/]+)\/fidelity$/);
      if (fidelityMatch && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as { fidelity?: unknown };
        const plan = await planFidelityReport(
          databaseAdapter,
          decodeURIComponent(fidelityMatch[1]!),
          body.fidelity,
          (type) => appCanRead(localDb, appId!, type) && appCanWriteMetadataCategory(localDb, appId!, typeCategory(type)),
        );
        if (!plan.ok) {
          res.writeHead(plan.status);
          json(res, plan.body);
          return;
        }
        const record =
          plan.write === null
            ? plan.record
            : await recordOriginalFidelity(
                databaseAdapter,
                plan.record,
                plan.write,
                clock,
                stampFor(plan.record.type, DEFAULT_STAND_IN_STANDARDS, true),
              );
        if (plan.write !== null) {
          changeNotifier.emit({
            eventType: "local-change-recorded",
            recordIds: [record.id],
            timestamp: record.updatedAt,
          });
        }
        json(res, {
          id: record.id,
          fidelity: record.fidelity,
          canonical_threshold: record.canonicalThreshold,
          recorded: plan.write !== null,
        });
        return;
      }

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
        // Read first, because the record is what the rest of this is derived
        // from. It is also the grant discriminant written into the row, and a
        // row labelled with a caller-supplied type would be readable by whoever
        // the caller named.
        const subject = await sdk.data.get(createStarkeepId(recordId));
        if (!subject || subject.deletedAt) {
          res.writeHead(404);
          json(res, { error: "Record not found" });
          return;
        }
        if (subject.standInRole) {
          res.writeHead(400);
          json(res, { error: "StandInMetadata", detail: STAND_IN_METADATA_REFUSAL });
          return;
        }
        const category = typeCategory(subject.type);
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
        const checked = checkMetadataValues(category as Category, metadata);
        if (!checked.ok) {
          res.writeHead(400);
          json(res, { error: checked.message });
          return;
        }
        // Through the SDK rather than the adapter, deliberately: the SDK also
        // moves the record's `updated_at`, which is the only thing that makes
        // this write visible to sync. See `DataOperations.putMetadata`.
        await sdk.data.putMetadata(subject.type, {
          recordId: createStarkeepId(recordId),
          ...metadata,
        });
        json(res, { ok: true });
        return;
      }

      // GET /data/records/:id/metadata/:typeId — read type-specific metadata for a record.
      // Requires read or readwrite access to the record's *own* type.
      //
      // The path's `typeId` is caller-supplied, so deriving the category from
      // it and checking the category grant let any grant in a category read
      // every record in that category — which is what the comment above this
      // route always claimed the code did and what the code did not do.
      //
      // The record's `type` decides both the grant check and which metadata
      // table answers, which leaves the path segment carrying nothing. It stays
      // in the URL because existing callers send it, and it is now ignored.
      const metadataReadMatch = path.match(/^\/data\/records\/([^/]+)\/metadata\/([^/]+)$/);
      if (metadataReadMatch && req.method === "GET") {
        const recordId = metadataReadMatch[1]!;
        const record = await sdk.data.get(createStarkeepId(recordId));
        if (!record || record.deletedAt) {
          res.writeHead(404);
          json(res, { error: "Record not found" });
          return;
        }
        if (!appCanRead(localDb, appId!, record.type)) {
          res.writeHead(403);
          json(res, { error: "AccessDenied", detail: `app "${appId}" has no read grant on type "${record.type}"` });
          return;
        }
        const category = typeCategory(record.type);
        if (category === "other") {
          // `other` has no metadata table; nothing to read.
          json(res, { metadata: null });
          return;
        }
        const metadata = await sdk.data.getMetadata(category, createStarkeepId(recordId));
        json(res, { metadata });
        return;
      }

      // GET /data/metadata/:category — the query grammar over one category's
      // per-category metadata table.
      //
      // The first route that lets a metadata column appear in predicate
      // position. It exists because `record_type` now sits on every metadata
      // row: the caller's grant compiles to `record_type IN (…)` on a leading
      // index column, so the gate rides inside the access path rather than
      // filtering what a scan returned. Without that column there was a ceiling
      // and no gate, and no predicate could be answered safely at all.
      const metadataQueryMatch = path.match(/^\/data\/metadata\/([^/]+)$/);
      if (metadataQueryMatch && req.method === "GET") {
        const category = decodeURIComponent(metadataQueryMatch[1]!);
        if (!isCategoryId(category)) {
          res.writeHead(400);
          json(res, { error: `"${category}" is not a category` });
          return;
        }
        await runSharedQuery(res, databaseAdapter, () =>
          planMetadataQuery(category, appGrants(localDb, appId!), queryParamsFrom(url.searchParams)),
        );
        return;
      }

      // GET /data/labels — the query grammar over shared_record_labels.
      //
      // `where` must pin `app_id` and `key`, which the schema enforces: the
      // reverse index is (app_id, key, deleted_at, value, record_id), so a
      // query pinning neither scans every app's assertions about every record.
      //
      // Labels are cross-app assertions, so the caller's own app id restricts
      // nothing here. What restricts the answer is `record_type IN (…)`, which
      // is the same gate every other read of shared data carries.
      if (path === "/data/labels" && req.method === "GET") {
        await runSharedQuery(res, databaseAdapter, () =>
          planLabelQuery(appGrants(localDb, appId!), queryParamsFrom(url.searchParams)),
        );
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
        // The same answer as the cloud: 404 for no record, 403 for a type the
        // caller's grants do not cover.
        if (!appCanRead(localDb, appId!, record.type)) {
          res.writeHead(403);
          json(res, { error: "Forbidden" });
          return;
        }
        json(res, {
          record: {
            id: record.id,
            kind: record.kind,
            type: record.type,
            category: typeCategory(record.type),
            created_at: new Date(record.createdAt.wallTime).toISOString(),
            updated_at: new Date(record.updatedAt.wallTime).toISOString(),
            version: record.version,
            content_hash: record.contentHash,
            object_storage_key: record.objectStorageKey,
            mime_type: record.mimeType,
            size_bytes: record.sizeBytes,
            original_filename: record.originalFilename,
            parent_id: record.parentId,
            stand_in_role: record.standInRole,
            fidelity: record.fidelity,
            canonical_threshold: record.canonicalThreshold,
            self_canonical: record.selfCanonical,
            path: record.kind === "data" && record.objectStorageKey
              ? await localAdapter.resolvePath(record.objectStorageKey)
              : null,
            // Same `include` vocabulary as the list route. Asking about one
            // record is the cheapest possible form of "is this record a
            // rendition"; without it the only way to answer that was to list
            // the library and look, which is O(library) to learn one bit.
            ...(url.searchParams.get("include")?.split(",").map((v) => v.trim()).includes("labels")
              ? {
                  labels: (
                    (await databaseAdapter.getLabelsByRecordIds([record.id])).get(record.id) ?? []
                  )
                    .filter((l) => !l.deletedAt)
                    .map((l) => ({ app_id: l.appId, key: l.key, value: l.value })),
                }
              : {}),
            ...(await (async () => {
              const summary = (
                await loadStandInSummariesForPage(
                  databaseAdapter,
                  [record],
                  DEFAULT_STAND_IN_STANDARDS,
                  localPlacementOf,
                )
              ).get(record.id);
              return summary ? { stand_ins: await renderStandInSummary(summary) } : {};
            })()),
          },
        });
        return;
      }

      // DELETE /data/records/:id — delete the item a listing shows.
      //
      // Cascades to the record's stand-ins and derived records, and to every
      // label on any of them, through the same planner the cloud's delete and
      // the SDK use. A canonical stand-in whose original is live is refused on
      // its own; deleting the original deletes both.
      if (recordMatch && req.method === "DELETE") {
        const record = await databaseAdapter.get(createStarkeepId(decodeURIComponent(recordMatch[1]!)));
        if (!record || record.deletedAt || !appCanRead(localDb, appId!, record.type)) {
          res.writeHead(404);
          json(res, { error: "Record not found" });
          return;
        }
        if (!appCanWrite(localDb, appId!, record.type)) {
          res.writeHead(403);
          json(res, { error: "Forbidden" });
          return;
        }
        const plan = await planRecordDelete(databaseAdapter, record);
        if (!plan.ok) {
          res.writeHead(plan.status);
          json(res, plan.body);
          return;
        }
        const deleted = await applyRecordDelete(databaseAdapter, plan, clock);
        changeNotifier.emit({
          eventType: "local-change-recorded",
          recordIds: deleted.map((r) => r.id),
          timestamp: deleted[deleted.length - 1]!.updatedAt,
        });
        json(res, { deleted: true, ids: deleted.map((r) => r.id) });
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

      // GET /admin/apps/:appId/install-steps — read the install/uninstall
      // step ledger for an app. Lets admin-web surface failed install state
      // (which step, what error) instead of forcing the operator to crack
      // open the sqlite DB. Returns rows even for apps with no registry row,
      // so a half-installed app whose ledger lingers after a crash is still
      // visible.
      const stepsMatch = path.match(/^\/admin\/apps\/([^/]+)\/install-steps$/);
      if (stepsMatch && req.method === "GET") {
        const targetAppId = decodeURIComponent(stepsMatch[1]!);
        const steps = listInstallSteps(localDb, targetAppId);
        json(res, { appId: targetAppId, steps });
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
      // Once the status line is out there is no response left to write. Calling
      // writeHead here throws ERR_HTTP_HEADERS_SENT from an async handler, which
      // Node 24 treats as an unhandled rejection and exits on — so a client
      // hanging up mid-download used to take the whole server with it. Drop the
      // connection instead; the peer learns the body is incomplete from the
      // truncated Content-Length.
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(500);
      json(res, { error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  // Last line of defence. Every known path into this handler is now guarded,
  // but the failure mode it protects against — one bad rejection anywhere in an
  // async handler terminating a server the operator's whole library is served
  // from — is severe enough to be worth catching generically as well. Degrade,
  // do not exit.
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection (surviving):", reason);
  });

  server.listen(PORT, LISTEN_HOST, () => {
    console.log(`Starkeep data server listening on http://${LISTEN_HOST}:${PORT}`);
  });

  const shutdown = async () => {
    sseClients.forEach(c => c.end());
    server.close();
    if (supervisor) await supervisor.stop();
    await watchManager.shutdown();
    // Before `sdk.close()`, not after. The SDK closes only a clock it built
    // itself, so flushing this one is this process's job — and the flush writes
    // through `syncStateStore`, which holds the same raw SQLite handle that
    // `sdk.close()` closes. Draining it afterwards throws on a closed database,
    // which loses the clock state *and* skips the `process.exit(0)` below,
    // leaving SIGTERM unable to stop the daemon.
    await nodeClock.close();
    await sdk.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", async () => {
    // Reuse shutdown so Ctrl-C on a dev process drains cleanly.
    await shutdown();
  });
  exitWhenOwnerIsGone(shutdown);
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

/**
 * True for the errors a peer produces by going away mid-body: an aborted fetch,
 * a tile scrolled out of view, a <video> that seeks and re-requests. `pipeline`
 * surfaces these as rejections indistinguishable in shape from a real failure,
 * so they have to be recognised by code.
 */
function isPeerGoneError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return (
    code === "ERR_STREAM_PREMATURE_CLOSE" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ERR_STREAM_DESTROYED"
  );
}

function json(res: import("node:http").ServerResponse, body: unknown) {
  if (!res.headersSent) res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/**
 * How long an inline variant URL stays valid. Long, deliberately — see the
 * call site.
 */
const VARIANT_URL_TTL_SECONDS = 6 * 60 * 60;

/** Why a stand-in takes no metadata row. Both metadata doors answer with it. */
const STAND_IN_METADATA_REFUSAL =
  "a stand-in carries no per-category metadata: its fidelity is its size, and the original's row describes the item, so metadata queries show one row per original";

/**
 * The MIME a stand-in's bytes are served as when its record carries none.
 * Other types fall back to octet-stream, which is what the file route has
 * always done for a record with no MIME.
 */
function mimeForStandIn(type: string): string {
  return STAND_IN_MIME_TYPES[type] ?? "application/octet-stream";
}

/**
 * The granularity a read token's expiry is rounded up to.
 *
 * This is what makes the browser cache work at all, and it is worth stating why
 * `Cache-Control` alone did not. The HTTP cache keys on the *full* URL, query
 * string and path included. A token baking `now + ttl` into its payload
 * produces a different URL for the same key on every call, so a page load asks
 * for hundreds of URLs it has never seen, misses on all of them, and
 * re-downloads the whole visible grid however generous the max-age.
 *
 * Quantising the expiry to a bucket boundary makes every request for a given
 * key within the same bucket produce a byte-identical URL, so the second load
 * is served from disk. The cost is that a token's effective lifetime varies
 * within the bucket — which is what a bucket is.
 *
 * An hour, matching the default TTL callers ask for.
 */
const TOKEN_EXPIRY_BUCKET_SECONDS = 60 * 60;

/**
 * Encode storage key + mime + expiry into a URL-safe signed token.
 *
 * Read tokens are quantised so the URL is stable; upload tokens are not. An
 * upload token is used once and should stay unique, and there is no cache for a
 * stable one to help.
 */
function createFileToken(key: string, mimeType: string, expiresIn: number): string {
  const expires = quantisedExpiry(expiresIn);
  const payload = `r|${key}|${mimeType}|${expires}`;
  const sig = createHmac("sha256", TOKEN_SECRET).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${sig}`;
}

/** A token's remaining life, floored at zero. */
function cacheSecondsFor(expires: number): number {
  return Math.max(0, Math.floor(expires - Date.now() / 1000));
}

function quantisedExpiry(expiresIn: number): number {
  const at = Date.now() / 1000 + expiresIn;
  // Rounded *up*, so the quantisation never shortens a caller's requested
  // lifetime — a token that expired early would turn a cache hit into a broken
  // image rather than a slow one.
  return Math.ceil(at / TOKEN_EXPIRY_BUCKET_SECONDS) * TOKEN_EXPIRY_BUCKET_SECONDS;
}

/** Verify and decode a file token. Returns null if invalid or expired. */
function verifyFileToken(
  token: string,
): { key: string; mimeType: string; expires: number } | null {
  const parsed = decodeSignedToken(token);
  if (!parsed) return null;
  if (parsed.scope !== "r") return null;
  return { key: parsed.key, mimeType: parsed.mimeType, expires: parsed.expires };
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
): { scope: string; key: string; mimeType: string; expires: number } | null {
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
    return { scope: "r", key: parts[0]!, mimeType: parts[1]!, expires };
  }
  if (parts.length !== 4) return null;
  const expires = parseInt(parts[3]!, 10);
  if (Date.now() / 1000 > expires) return null;
  return { scope: parts[0]!, key: parts[1]!, mimeType: parts[2]!, expires };
}

main().catch((err) => {
  console.error("Failed to start data server:", err);
  process.exit(1);
});
