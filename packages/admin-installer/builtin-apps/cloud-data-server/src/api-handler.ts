/**
 * Cloud API Lambda handler — per-app isolated access to DSQL and S3.
 *
 * The Lambda execution role has NO data-plane access. For every request:
 *   1. Extract appId from the path prefix /apps/{appId}/
 *   2. STS-assume the app's IAM role (${STACK_PREFIX}-app-{appId}-role), cached ~14 min
 *   3. Connect to DSQL as the app's PG role using DbConnect (not Admin)
 *   4. Scope all S3 access to apps/{appId}/ prefix under the app role
 *
 * Environment variables:
 *   AURORA_ENDPOINT  — Aurora DSQL cluster hostname
 *   S3_BUCKET        — S3 bucket for object storage (files)
 *   STACK_PREFIX     — e.g. "starkeep"
 *   AWS_REGION       — set automatically by Lambda runtime
 *
 * The CDS Lambda's broker capability is the cloud-data-server role's
 * "broker-power" inline policy + each per-app role trusting the CDS role
 * directly. AssumeRole is a single hop: Lambda exec role → per-app role.
 * Manager is not involved in the runtime data path.
 */

import {
  createHash,
  createHmac,
  createPublicKey,
  randomUUID,
  timingSafeEqual,
  verify as nodeVerify,
  type KeyObject,
} from "node:crypto";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { SSMClient, GetParameterCommand, ParameterNotFound } from "@aws-sdk/client-ssm";
import { getSignedUrl as getCloudFrontSignedUrl } from "@aws-sdk/cloudfront-signer";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import pg from "pg";
import { AuroraDsqlDatabaseAdapter, postgresCompiler } from "@starkeep/storage-aurora-dsql";
import { S3ObjectStorageAdapter } from "@starkeep/storage-s3";
import {
  generateId,
  createHLCClock,
  serializeHLC,
  deserializeHLC,
  appSyncableObjectKey,
  contentHashFromDataRecordObjectKey,
  dataRecordObjectKey,
  parseVariantLongEdges,
  resolveVariants,
  isRetrievalIntent,
  tagsForIntent,
  observationFor,
  shouldReplace,
  reconcileAvailability,
  vanishedObservation,
  INTENT_TAG_KEY,
  LADDER_TAG_KEY,
  LADDER_TAG_COMPLETE,
  estimateRestore,
  DEFAULT_AVAILABILITY,
  DEFAULT_RETRIEVAL_INTENT,
  RETRIEVAL_INTENTS,
  typeCategory,
  getCategory,
  isCategoryId,
  isKnownType,
  planLabelWrites,
  planLabelRetractions,
  labelValueSetKey,
  parseLabelRef,
} from "@starkeep/protocol-primitives";
import type {
  DataRecord,
  StarkeepId,
  HLCClock,
  MetadataRow,
  RecordLabel,
  AvailabilityEventKind,
  InventoryRow,
  RecordAvailability,
  ResolvedVariant,
  RetrievalIntent,
  VariantCandidate,
} from "@starkeep/protocol-primitives";
import {
  createInProcessSyncTransport,
  sanitizeExchangeRequest,
  InvalidExchangeRequest,
} from "@starkeep/sync-engine";
import {
  DsqlAppSyncableNamespaceStore,
  DsqlAppSyncableApplier,
  withOccRetry,
} from "@starkeep/storage-aurora-dsql";
import { createAppSpecificFactory } from "@starkeep/shared-space-api";
import type { AppSpecificOperations } from "@starkeep/shared-space-api";
import type {
  DatabaseClientFactory,
  DatabaseClient,
  AuroraDsqlDatabaseAdapterOptions,
} from "@starkeep/storage-aurora-dsql";
import type { Filter, DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";
import { sha256HexToBase64, loadVariantsForPage } from "@starkeep/storage-adapter";
import type { StoredAvailability } from "@starkeep/storage-adapter";
import { ok, clientErr, type APIGatewayEvent, type LambdaContext } from "./handler-utils.js";
import { userPoolConfig, verifyUserToken } from "./verify-user-token.js";
import {
  loadAccessGrants,
  loadDeclaredLabelKeys,
  canRead,
  canWrite,
  canReadCategory,
  canWriteCategory,
  type AccessGrants,
} from "./access-enforcer.js";

// ---------------------------------------------------------------------------
// Per-app credential cache (STS sessions ~15 min, refreshed at 14 min)
// ---------------------------------------------------------------------------

interface CachedCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiresAt: number; // ms epoch
}

const credentialCache = new Map<string, CachedCreds>();
const CRED_REFRESH_BUFFER_MS = 60_000; // refresh 60s before expiry

// ---------------------------------------------------------------------------
// Per-app HMAC secret cache (SSM SecureString, refreshed every 5 min)
// ---------------------------------------------------------------------------
//
// Every /apps/{appId}/* request is HMAC-signed (see packages/app-client/src/
// sign.ts). The verifier below fetches the secret from
// /${stackPrefix}/app-creds/${appId} once per warm Lambda instance and caches
// it. The same SecureString is written by the installer at cloud install
// (admin-installer/src/app-creds.ts) and mirrored from the local-side hmac
// secret so the sync supervisor signs with the same key the verifier expects.

interface CachedHmacSecret {
  hmacSecret: string;
  fetchedAt: number;
}

// Per-app secret cache lifetime. Defaults to 5 min (trading SSM call volume
// for up to a 5-min lag on credential rotation/revocation). Overridable via
// the HMAC_CACHE_TTL_MS Lambda env var — the Tier-3 e2e suite sets it low so
// installs/uninstalls take effect promptly without waiting out the cache; left
// unset in real deployments, which keep the 5-min default.
function resolveHmacCacheTtlMs(): number {
  const raw = process.env.HMAC_CACHE_TTL_MS;
  if (raw === undefined) return 5 * 60_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5 * 60_000;
}

const HMAC_CACHE_TTL_MS = resolveHmacCacheTtlMs();
const hmacSecretCache = new Map<string, CachedHmacSecret>();

let ssmClientSingleton: SSMClient | null = null;
function getSsmClient(): SSMClient {
  if (ssmClientSingleton) return ssmClientSingleton;
  ssmClientSingleton = new SSMClient({
    region: process.env.AWS_REGION ?? "us-east-1",
  });
  return ssmClientSingleton;
}

// ---------------------------------------------------------------------------
// Per-device public key cache (SSM, same lifetime as the app secrets above)
// ---------------------------------------------------------------------------
//
// A handset cannot hold a per-app HMAC secret: it is symmetric, so whoever
// holds it *is* the app; it is extractable from a distributable APK; it never
// expires; and revoking it after a lost phone would break every other client of
// that app. So devices get an asymmetric key instead — they sign, we verify,
// and nothing secret is stored on this side.
//
// **Why SSM and not a table.** This runs *before* any per-app role is assumed,
// and the cloud-data-server's own credentials deliberately have no access to
// shared data. A device registry in `shared.*` would be unreadable by the code
// that has to read it. The app secrets already had this problem and already
// solved it, so devices take the identical path and inherit the cache, the
// failure modes and the revocation story — revoking is deleting one parameter.
//
// **Why under `app-creds/` rather than a `device-keys/` prefix of its own.**
// `/${stackPrefix}/app-creds/*` is the *only* SSM path this Lambda's role can
// read, and widening it would mean editing the runtime policy *and* the
// foundational permissions boundary — a bootstrap CloudFormation change, for a
// parameter that is not secret. `_cloudfront-signing` already established the
// convention of reserved names under this prefix, and it is collision-free by
// construction: `CLOUD_APP_ID_RE` requires an app id to start `[a-z0-9]`, so no
// app can ever claim a name beginning with an underscore.
//
// Registration is not self-service: admin-web writes the parameter, having
// authenticated the operator and chosen which Cognito user the device belongs
// to. `userId` is recorded from day one even though nothing reads it yet —
// see todo #52. Capturing it now is what saves every device a migration when
// shared data is finally partitioned per user.

interface CachedDeviceKey {
  /** Base64 SPKI, exactly as registered. */
  publicKeySpki: string;
  /** The Cognito user this device was paired for. Recorded, not yet enforced. */
  userId: string | null;
  fetchedAt: number;
}

const deviceKeyCache = new Map<string, CachedDeviceKey>();

/**
 * Device ids are used to build an SSM parameter name, so they are constrained
 * rather than trusted. Without this, a crafted `X-Starkeep-Device-Id` could
 * walk the parameter path with `../` and turn a signature check into a probe
 * for arbitrary parameters — including the app secrets sitting one level up.
 */
function isValidDeviceId(deviceId: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(deviceId);
}

async function loadDevicePublicKey(deviceId: string): Promise<CachedDeviceKey | null> {
  if (!isValidDeviceId(deviceId)) return null;
  const cached = deviceKeyCache.get(deviceId);
  if (cached && Date.now() - cached.fetchedAt < HMAC_CACHE_TTL_MS) return cached;

  const stackPrefix = process.env.STACK_PREFIX;
  if (!stackPrefix) throw new Error("STACK_PREFIX env var is required");
  try {
    const result = await getSsmClient().send(
      new GetParameterCommand({
        Name: `/${stackPrefix}/app-creds/_device-${deviceId}`,
        WithDecryption: true,
      }),
    );
    const raw = result.Parameter?.Value;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { publicKeySpki?: string; userId?: string };
    if (!parsed.publicKeySpki) return null;
    const entry: CachedDeviceKey = {
      publicKeySpki: parsed.publicKeySpki,
      userId: parsed.userId ?? null,
      fetchedAt: Date.now(),
    };
    deviceKeyCache.set(deviceId, entry);
    return entry;
  } catch (err) {
    if (err instanceof ParameterNotFound) return null;
    throw err;
  }
}

async function loadAppHmacSecret(appId: string): Promise<string | null> {
  const cached = hmacSecretCache.get(appId);
  if (cached && Date.now() - cached.fetchedAt < HMAC_CACHE_TTL_MS) {
    return cached.hmacSecret;
  }
  const stackPrefix = process.env.STACK_PREFIX;
  if (!stackPrefix) throw new Error("STACK_PREFIX env var is required");
  const name = `/${stackPrefix}/app-creds/${appId}`;
  try {
    const result = await getSsmClient().send(
      new GetParameterCommand({ Name: name, WithDecryption: true }),
    );
    const raw = result.Parameter?.Value;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { hmacSecret?: string };
    if (!parsed.hmacSecret) return null;
    hmacSecretCache.set(appId, {
      hmacSecret: parsed.hmacSecret,
      fetchedAt: Date.now(),
    });
    return parsed.hmacSecret;
  } catch (err) {
    if (err instanceof ParameterNotFound) return null;
    throw err;
  }
}

// Freshness window for the signed timestamp (skew-tolerant). Mirrors
// APP_SIG_MAX_SKEW_MS in @starkeep/app-client/src/sign.ts; hand-kept because
// this handler is a separately-deployed artifact and cannot import the package.
const APP_SIG_MAX_SKEW_MS = 5 * 60_000;

// Canonical signed path: pathname only, percent-decoded. Mirrors
// canonicalSignedPath in @starkeep/app-client/src/sign.ts. The subPath the
// handler routes on is already query-free and slash-normalized by API Gateway;
// decoding here aligns it with the logical path the client signed.
function canonicalSignedPath(path: string): string {
  const q = path.indexOf("?");
  const pathname = q >= 0 ? path.slice(0, q) : path;
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/**
 * Verify the X-Starkeep-App-{Id,Sig,Ts} headers against the appId + subPath
 * from the URL. Returns ok on success; an error object otherwise. Mirrors
 * `signRequest` in @starkeep/app-client/src/sign.ts: the signature binds
 * method, path, and a timestamp (enforced against a freshness window) so a
 * captured request can be neither replayed against a different endpoint nor
 * replayed indefinitely.
 *
 * Body is the raw request bytes the client signed. GET/HEAD sign over the
 * empty string. For base64-encoded API Gateway events we must decode first
 * so the bytes match what the client transmitted.
 */
export function validateAppHmac(
  pathAppId: string,
  method: string,
  subPath: string,
  headers: Record<string, string | undefined>,
  bodyBytes: Buffer,
  hmacSecret: string,
): { ok: true } | { ok: false; status: number; message: string } {
  const headerAppId =
    headers["x-starkeep-app-id"]
    ?? headers["X-Starkeep-App-Id"]
    ?? headers["X-STARKEEP-APP-ID"];
  const headerSig =
    headers["x-starkeep-app-sig"]
    ?? headers["X-Starkeep-App-Sig"]
    ?? headers["X-STARKEEP-APP-SIG"];
  const headerTs =
    headers["x-starkeep-app-ts"]
    ?? headers["X-Starkeep-App-Ts"]
    ?? headers["X-STARKEEP-APP-TS"];
  if (!headerAppId || !headerSig || !headerTs) {
    return { ok: false, status: 401, message: "Missing X-Starkeep-App-{Id,Sig,Ts} headers" };
  }
  if (headerAppId !== pathAppId) {
    return { ok: false, status: 401, message: "Header appId does not match path" };
  }
  const tsMs = Number(headerTs);
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > APP_SIG_MAX_SKEW_MS) {
    return { ok: false, status: 401, message: "Stale or invalid signature timestamp" };
  }
  const isEmptyBody = method === "GET" || method === "HEAD";
  const signedBody = isEmptyBody ? Buffer.alloc(0) : bodyBytes;
  const prefix = Buffer.from(
    `${pathAppId}:${method.toUpperCase()}:${canonicalSignedPath(subPath)}:${tsMs}:`,
    "utf8",
  );
  const expected = createHmac("sha256", hmacSecret)
    .update(Buffer.concat([prefix as unknown as Uint8Array, signedBody as unknown as Uint8Array]) as unknown as Uint8Array)
    .digest("hex");
  if (
    expected.length !== headerSig.length
    || !timingSafeEqual(Buffer.from(expected, "utf8") as unknown as Uint8Array, Buffer.from(headerSig, "utf8") as unknown as Uint8Array)
  ) {
    return { ok: false, status: 401, message: "Invalid signature" };
  }
  return { ok: true };
}

/**
 * Verify a device-signed request.
 *
 * The signed message is **byte-identical** to the HMAC one — same prefix, same
 * canonical path, same empty-body-on-GET rule, same skew window. Only the
 * primitive differs. That is deliberate: a second canonicalisation is how two
 * implementations come to disagree about what was signed, and the disagreement
 * surfaces as an unexplainable 401 on one route long after the change.
 *
 * The device is authorised for whichever app it names. On a handset our app is
 * the only thing holding the key, and it legitimately needs two channels
 * (`starkeep-drive` for shared records, `photos` for app-specific rows), so a
 * per-app device key would mean several registrations for one pairing. What
 * this gives up is per-app attribution of *authorisation*; origin attribution
 * is unaffected, since `origin_app_id` is on the record itself.
 */
function validateDeviceSignature(
  pathAppId: string,
  method: string,
  subPath: string,
  headers: Record<string, string | undefined>,
  bodyBytes: Buffer,
  device: CachedDeviceKey,
): { ok: true } | { ok: false; status: number; message: string } {
  const headerSig = headers["x-starkeep-device-sig"];
  const headerTs = headers["x-starkeep-app-ts"];
  const headerAppId = headers["x-starkeep-app-id"];
  if (!headerSig || !headerTs || !headerAppId) {
    return {
      ok: false,
      status: 401,
      message: "Missing X-Starkeep-Device-Sig / X-Starkeep-App-{Id,Ts} headers",
    };
  }
  if (headerAppId !== pathAppId) {
    return { ok: false, status: 401, message: "Header appId does not match path" };
  }
  const tsMs = Number(headerTs);
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > APP_SIG_MAX_SKEW_MS) {
    return { ok: false, status: 401, message: "Stale or invalid signature timestamp" };
  }

  const isEmptyBody = method === "GET" || method === "HEAD";
  const signedBody = isEmptyBody ? Buffer.alloc(0) : bodyBytes;
  const message = Buffer.concat([
    Buffer.from(
      `${pathAppId}:${method.toUpperCase()}:${canonicalSignedPath(subPath)}:${tsMs}:`,
      "utf8",
    ) as unknown as Uint8Array,
    signedBody as unknown as Uint8Array,
  ]);

  let key: KeyObject;
  try {
    key = createPublicKey({
      key: Buffer.from(device.publicKeySpki, "base64"),
      type: "spki",
      format: "der",
    });
  } catch {
    // A registered key that will not parse is a registration bug, not a caller
    // error — but it must still deny rather than throw, or one malformed
    // parameter turns every request from that device into a 500.
    return { ok: false, status: 401, message: "Registered device key is unusable" };
  }
  if (key.asymmetricKeyType !== "ed25519") {
    return { ok: false, status: 401, message: "Registered device key is not Ed25519" };
  }

  let signature: Buffer;
  try {
    signature = Buffer.from(headerSig, "base64");
  } catch {
    return { ok: false, status: 401, message: "Invalid device signature encoding" };
  }
  // `verify` is constant-time internally and returns false rather than throwing
  // on a malformed signature.
  if (!nodeVerify(null, message as unknown as Uint8Array, key, signature as unknown as Uint8Array)) {
    return { ok: false, status: 401, message: "Invalid device signature" };
  }
  return { ok: true };
}

async function getAppCreds(appId: string, accountId: string): Promise<CachedCreds> {
  const cached = credentialCache.get(appId);
  if (cached && cached.expiresAt - Date.now() > CRED_REFRESH_BUFFER_MS) {
    return cached;
  }

  const stackPrefix = process.env.STACK_PREFIX;
  const region = process.env.AWS_REGION ?? "us-east-1";
  if (!stackPrefix) {
    throw new Error("STACK_PREFIX env var is required");
  }

  const appRoleArn = `arn:aws:iam::${accountId}:role/${stackPrefix}-app-${appId}-role`;

  // Single-hop AssumeRole: the CDS Lambda exec role's broker-power policy
  // permits sts:AssumeRole on ${prefix}-app-*, and every per-app role's
  // trust policy lists the CDS role as a principal. No Manager involvement.
  const sts = new STSClient({ region });
  const appResult = await sts.send(new AssumeRoleCommand({
    RoleArn: appRoleArn,
    RoleSessionName: `lambda-app-${appId}-${Date.now()}`,
    DurationSeconds: 900,
  }));
  const ac = appResult.Credentials;
  if (!ac?.AccessKeyId || !ac.SecretAccessKey || !ac.SessionToken || !ac.Expiration) {
    throw new Error(`Failed to assume app role for ${appId}`);
  }

  const creds: CachedCreds = {
    accessKeyId: ac.AccessKeyId,
    secretAccessKey: ac.SecretAccessKey,
    sessionToken: ac.SessionToken,
    expiresAt: ac.Expiration.getTime(),
  };
  credentialCache.set(appId, creds);
  return creds;
}

// Account ID parsed from the Lambda invocation context's ARN. Lambda does not
// expose the function ARN as an env var — only the invocation context does
// (`context.invokedFunctionArn`), so the caller must thread it in.
function getAccountId(invokedFunctionArn: string): string {
  const arnParts = invokedFunctionArn.split(":");
  const accountId = arnParts[4];
  if (!accountId) {
    throw new Error(`Cannot parse account ID from invokedFunctionArn: ${invokedFunctionArn}`);
  }
  return accountId;
}

// ---------------------------------------------------------------------------
// Per-app DSQL client factory
// ---------------------------------------------------------------------------

// DSQL refuses a connection whose IAM→PG role mapping isn't yet authorized with
// SQLSTATE 28000 (invalid_authorization_specification), which the pg driver
// surfaces as `error: unable to accept connection, access denied`; 28P01
// (invalid_password) is the adjacent shape. Detect both by code, falling back
// to the message when the driver doesn't attach a code to the connect error.
function isConnectAuthDenied(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  if (e?.code === "28000" || e?.code === "28P01") return true;
  return (e?.message ?? "").toLowerCase().includes("unable to accept connection");
}

class AppDsqlClientFactory implements DatabaseClientFactory {
  constructor(
    private readonly appId: string,
    private readonly creds: CachedCreds,
    private readonly stackPrefix: string,
  ) {}

  async createClient(options: AuroraDsqlDatabaseAdapterOptions): Promise<DatabaseClient> {
    const { hostname, region } = options;
    const pgUser = `${this.stackPrefix}_app_${this.appId}`.toLowerCase().replace(/-/g, "_");
    const creds = this.creds;

    const connectOnce = async (): Promise<pg.Client> => {
      const signer = new DsqlSigner({
        hostname,
        region,
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
        },
      });
      const token = await signer.getDbConnectAuthToken();
      const client = new pg.Client({
        host: hostname,
        port: 5432,
        database: options.database ?? "postgres",
        user: pgUser,
        password: token,
        ssl: { rejectUnauthorized: true },
      });
      // Without an 'error' listener, an async socket failure (DSQL token
      // expiry, idle timeout, network blip) emits 'error' on the Client with
      // no handler → Node throws uncaughtException → the Lambda worker dies
      // mid-invocation and API Gateway returns its default 500. Attach a
      // no-op-with-log listener so socket errors stay async failures we can
      // surface in CloudWatch instead of process-killers.
      client.on("error", (err) => {
        console.warn("[cds] pg client async error:", (err as Error).message);
      });
      try {
        await client.connect();
      } catch (err) {
        // connect() rejected — the client owns a half-open socket; close it so a
        // failed attempt doesn't leak an fd or a dangling 'error' emitter before
        // the retry mints a fresh client.
        await client.end().catch(() => {});
        throw err;
      }
      return client;
    };

    // Connect-time authorization can transiently fail right after an app is
    // installed: DSQL maps the app's IAM role to its PG role via `AWS IAM GRANT`
    // (admin-installer/src/dsql-ddl.ts), and that mapping takes time to
    // propagate into DSQL's connection authorizer. Until it does, connect()
    // rejects with SQLSTATE 28000 ("unable to accept connection, access
    // denied"). This is distinct from the query-time 28000 retry below, which
    // reconnects an already-authorized role whose DbConnect token has expired —
    // here the *first* connection is refused. Retry with bounded backoff so a
    // just-installed app becomes usable without a hard 500. The budget stays
    // well under the API Gateway ~30s integration timeout; propagation longer
    // than that is a gate-at-install concern, not something to absorb per
    // request.
    const createPgClient = async (): Promise<pg.Client> => {
      const maxAttempts = 6;
      const maxDelayMs = 4000;
      let delay = 500;
      const start = Date.now();
      for (let attempt = 1; ; attempt++) {
        try {
          const client = await connectOnce();
          if (attempt > 1) {
            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            console.log(
              `[cds] dsql connect for ${this.appId}: succeeded on attempt ${attempt} after ${elapsed}s`,
            );
          }
          return client;
        } catch (err) {
          if (attempt >= maxAttempts || !isConnectAuthDenied(err)) throw err;
          const elapsed = ((Date.now() - start) / 1000).toFixed(1);
          console.warn(
            `[cds] dsql connect for ${this.appId}: attempt ${attempt} refused ` +
              `(${(err as Error).message}) at ${elapsed}s, retrying in ${(delay / 1000).toFixed(1)}s`,
          );
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(delay * 2, maxDelayMs);
        }
      }
    };

    let inner = await createPgClient();

    return {
      async query(text, values) {
        try {
          const result = await inner.query(text, values);
          return { rows: result.rows };
        } catch (err: unknown) {
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

// ---------------------------------------------------------------------------
// Per-request adapter creation (not cached — creds are cached separately)
// ---------------------------------------------------------------------------

// Test seam: every DB access in the handler flows through one
// DatabaseClientFactory (the records adapter, the grants/clock client, and the
// app-syncable source all call createClient on the factory makeAdapters
// returns), so swapping the factory here is sufficient to fake DSQL entirely.
let databaseClientFactoryOverride: DatabaseClientFactory | null = null;
export function __setDatabaseClientFactoryForTests(
  factory: DatabaseClientFactory | null,
): void {
  databaseClientFactoryOverride = factory;
}

function makeAdapters(appId: string, creds: CachedCreds) {
  const region = process.env.AWS_REGION ?? "us-east-1";
  const auroraEndpoint = process.env.AURORA_ENDPOINT;
  const s3Bucket = process.env.S3_BUCKET;
  const stackPrefix = process.env.STACK_PREFIX ?? "starkeep";

  if (!auroraEndpoint) throw new Error("AURORA_ENDPOINT env var is required");
  if (!s3Bucket) throw new Error("S3_BUCKET env var is required");

  const clientFactory: DatabaseClientFactory =
    databaseClientFactoryOverride ?? new AppDsqlClientFactory(appId, creds, stackPrefix);

  const db = new AuroraDsqlDatabaseAdapter(
    { hostname: auroraEndpoint, region },
    clientFactory,
  );

  const storage = new S3ObjectStorageAdapter({
    bucketName: s3Bucket,
    region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });

  return { db, storage, clientFactory, auroraEndpoint, region };
}

// Seed the cloud HLC clock from the highest cloud-stamped timestamp visible
// to this request's app role. Serialized HLCs sort lexically because the
// wall-time and counter components are zero-padded hex (see serializeHLC).
// Records with no cloud-stamped row return ZERO state; the wall clock will
// dominate going forward.
//
// Fragile invariant: the seed query is filtered by the caller's per-extension
// read grants (rows the assumed app role can SELECT). HLC correctness under
// LWW relies on "rows this request can affect" ⊆ "rows the seed reads". Today
// the only cloud-side write path is DELETE /data/records/{id} (tombstone),
// and an app can only delete rows of types it has write grants on — which
// implies it can also read them, so the set inclusion holds. If a future
// cloud write path is added that touches rows the caller cannot also SELECT
// (e.g. an admin endpoint, a cross-type cleanup pass, a sharing-token op),
// this seed will underestimate the true cloud max and let the new write
// mint a stamp lower than an existing cloud stamp on the same record.
// Per-Lambda-instance nodeId. The HLC clock requires nodeId to be unique
// per replica — using a literal "cloud" let two warm Lambda containers mint
// timestamps with the same (wallTime, counter, nodeId), violating ordering.
// AWS_LAMBDA_LOG_STREAM_NAME is set per execution-environment instance and
// stable across invocations within that env. Outside Lambda (local tests),
// fall back to a process-lifetime UUID so test runs still produce a stable
// id. The `cloud-` prefix lets makeCloudClock filter the records-table for
// any cloud replica's max stamp, regardless of which instance wrote it.
const CLOUD_NODE_ID = `cloud-${process.env.AWS_LAMBDA_LOG_STREAM_NAME ?? randomUUID()}`;

async function makeCloudClock(client: DatabaseClient): Promise<HLCClock> {
  const seedQuery = postgresCompiler
    .selectFrom("shared.records")
    .select("updated_at")
    .where("updated_at", "like", "%:cloud-%")
    .orderBy("updated_at", "desc")
    .limit(1)
    .compile();
  const result = await client.query(seedQuery.sql, [...seedQuery.parameters]);
  let initialState: { wallTime: number; counter: number } | undefined;
  if (result.rows.length > 0) {
    const row = result.rows[0] as { updated_at: string };
    const parsed = deserializeHLC(row.updated_at);
    initialState = { wallTime: parsed.wallTime, counter: parsed.counter };
  }
  return createHLCClock({
    nodeId: CLOUD_NODE_ID,
    wallClockFunction: Date.now,
    ...(initialState ? { initialState } : {}),
  });
}

// ---------------------------------------------------------------------------
// Path parsing
// ---------------------------------------------------------------------------

// Mirrors CLOUD_APP_ID_RE in packages/admin-installer/src/iam.ts. Kept in sync
// by hand because the cloud handler lives in a separately-deployed artifact
// and cannot import from the installer package at runtime.
// The reserved app id of the Starkeep Drive (User-Data-Owner) channel — the
// single channel that carries all shared records. Mirrors
// USER_DATA_OWNER_APP_ID in packages/admin-installer/src/iam.ts; kept in sync by
// hand because this handler is a separately-deployed artifact.
const DRIVE_APP_ID = "starkeep-drive";

export function parseAppPath(rawPath: string): { appId: string; subPath: string } | null {
  const match = rawPath.match(/^\/apps\/([a-z0-9][a-z0-9._-]*)(\/.*)?$/);
  if (!match) return null;
  return { appId: match[1]!, subPath: match[2] ?? "/" };
}

// Authorize an object-storage key against the caller's grants. Keys live in
// two namespaces (see packages/protocol-primitives/src/storage/object-keys.ts):
//   shared/<typeId>/<shard>/<hash>   — gated by per-type read/write grants
//   apps/<appId>/syncable/<...>      — owned by the named app; only that app
//                                       may touch it via its own files routes
export function parseObjectKey(
  callerAppId: string,
  decodedKey: string,
  grants: AccessGrants,
  mode: "read" | "write",
): { ok: true } | { ok: false; status: number; message: string } {
  // Reject path traversal outright in EITHER namespace. Signed URLs (S3 or
  // CloudFront) are fetched by clients/edges that normalize ".." path segments,
  // so a key like shared/image/../audio/<hash> could resolve to a DIFFERENT
  // category's bytes than the one authorized here. Legit content-addressed and
  // app-syncable keys never contain "..". This is load-bearing now that the
  // shared read path has no per-app IAM ceiling behind CloudFront signing.
  if (decodedKey.split("/").includes("..")) {
    return { ok: false, status: 400, message: "Invalid key" };
  }
  if (decodedKey.startsWith("shared/")) {
    // Strict shape: shared/<category>/<shard>/<hash>, every segment drawn from
    // a safe alphabet (no dots, slashes, %-escapes, whitespace, or control
    // chars). The category is the derived category (see object-keys.ts), so
    // authorize at the category level. Anything that isn't a clean
    // content-addressed blob key is rejected before it can be signed.
    const m = decodedKey.match(
      /^shared\/([a-z0-9_-]+)\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/,
    );
    if (!m) return { ok: false, status: 400, message: "Invalid shared key" };
    const category = m[1]!;
    const allowed =
      mode === "read" ? canReadCategory(grants, category) : canWriteCategory(grants, category);
    if (!allowed) return { ok: false, status: 403, message: "Forbidden" };
    return { ok: true };
  }
  if (decodedKey.startsWith("apps/")) {
    const segments = decodedKey.split("/");
    if (
      segments.length < 4 ||
      !segments[1] ||
      segments[2] !== "syncable" ||
      !segments[3]
    ) {
      return { ok: false, status: 400, message: "Invalid app-syncable key" };
    }
    if (segments[1] !== callerAppId) {
      return { ok: false, status: 403, message: "Forbidden (cross-app syncable key)" };
    }
    return { ok: true };
  }
  return { ok: false, status: 400, message: "Unknown key namespace" };
}

// ---------------------------------------------------------------------------
// CloudFront signed URLs for shared file bytes (Part B)
//
// Shared blob reads are served through the platform CloudFront distribution's
// `shared/*` behavior (signed requests, edge-cached) instead of S3 presigned
// GETs. The signing config — { keyPairId, domain, privateKey } — lives in one
// SSM SecureString (name in CLOUDFRONT_SIGNING_PARAM), read once per warm
// container. The private key never leaves this Lambda; app code cannot reach
// it (only the CDS role has app-creds SSM read).
// ---------------------------------------------------------------------------

interface CloudFrontSigningConfig {
  keyPairId: string;
  domain: string;
  privateKey: string;
}

let cloudFrontConfigCache: { config: CloudFrontSigningConfig; fetchedAt: number } | null = null;

async function loadCloudFrontSigningConfig(): Promise<CloudFrontSigningConfig> {
  if (cloudFrontConfigCache && Date.now() - cloudFrontConfigCache.fetchedAt < HMAC_CACHE_TTL_MS) {
    return cloudFrontConfigCache.config;
  }
  const name = process.env.CLOUDFRONT_SIGNING_PARAM;
  if (!name) throw new Error("CLOUDFRONT_SIGNING_PARAM env var is required");
  const result = await getSsmClient().send(
    new GetParameterCommand({ Name: name, WithDecryption: true }),
  );
  const raw = result.Parameter?.Value;
  if (!raw) throw new Error("CloudFront signing parameter is empty");
  const parsed = JSON.parse(raw) as Partial<CloudFrontSigningConfig>;
  if (!parsed.keyPairId || !parsed.domain || !parsed.privateKey) {
    throw new Error("CloudFront signing parameter is malformed");
  }
  cloudFrontConfigCache = {
    config: parsed as CloudFrontSigningConfig,
    fetchedAt: Date.now(),
  };
  return cloudFrontConfigCache.config;
}

/**
 * The single pre-sign revalidation chokepoint for shared-file CloudFront URLs.
 *
 * Every shared file-url route mints its URL through here; no route may reach
 * the CloudFront signer around it. With the per-app IAM ceiling gone from the
 * shared read path (see data-roles-and-permissions.md / the CloudFront plan),
 * this in-process re-check is the last per-request line of defense: it re-parses
 * the key against the caller's grants, REQUIRES the `shared/` namespace (the
 * distribution never serves apps/* or any other prefix), and re-asserts the
 * key's category against the caller's granted categories. Adversarial key
 * handling (traversal, foreign categories, encoding tricks) is the whole point,
 * so it is covered by dedicated tests.
 */
export async function signSharedCloudFrontUrl(
  callerAppId: string,
  key: string,
  grants: AccessGrants,
  expiresInSec: number,
): Promise<{ ok: true; url: string } | { ok: false; status: number; message: string }> {
  // (1) Re-validate the key against the caller's grants (namespace, segment
  // shape, and — for shared/ — the category read grant).
  const check = parseObjectKey(callerAppId, key, grants, "read");
  if (!check.ok) return check;
  // (2) Namespace requirement: CloudFront only ever signs shared/* bytes. Any
  // other namespace (apps/*, unknown) is rejected even though parseObjectKey
  // may have allowed it for an app's own syncable files — those never go
  // through CloudFront.
  if (!key.startsWith("shared/")) {
    return { ok: false, status: 400, message: "CloudFront signing is only for shared keys" };
  }
  // (3) Redundant category re-check. parseObjectKey already did this for the
  // shared/ branch, but this is the load-bearing defense line, so assert it
  // explicitly here rather than trusting the call above.
  const category = key.split("/")[1];
  if (!category || !canReadCategory(grants, category)) {
    return { ok: false, status: 403, message: "Forbidden" };
  }
  const cfg = await loadCloudFrontSigningConfig();
  // Content-addressed keys contain only URL-safe chars (lowercase category ids,
  // hex shards/hashes, slashes), and parseObjectKey has rejected anything else,
  // so the key is safe to place directly in the URL path.
  const url = getCloudFrontSignedUrl({
    url: `https://${cfg.domain}/${key}`,
    keyPairId: cfg.keyPairId,
    privateKey: cfg.privateKey,
    dateLessThan: new Date(Date.now() + Math.max(1, expiresInSec) * 1000).toISOString(),
  });
  return { ok: true, url };
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

// `metadata` is only included when the caller opted into enrichment
// (?include=metadata). `undefined` omits the field entirely; `null` means
// "enrichment requested, but this record has no metadata row" (or its bytes
// were ingested by a path that doesn't extract metadata — e.g. the LDS folder
// watcher — so it may be backfilled later).
function recordToResponse(
  record: DataRecord,
  metadata?: MetadataRow | null,
  labels?: RecordLabel[],
  variants?: Record<string, ResolvedVariant & { url?: string }>,
  availability?: RecordAvailability,
) {
  return {
    id: record.id,
    type: record.type,
    category: typeCategory(record.type),
    created_at: new Date(record.createdAt.wallTime).toISOString(),
    updated_at: new Date(record.updatedAt.wallTime).toISOString(),
    version: record.version,
    mime_type: record.mimeType,
    size_bytes: record.sizeBytes,
    content_hash: record.contentHash,
    object_storage_key: record.objectStorageKey,
    original_filename: record.originalFilename,
    origin_app_id: record.originAppId,
    parent_id: record.parentId,
    ...(metadata !== undefined ? { metadata } : {}),
    // `[]` rather than null when a record has none: absence of labels is an
    // empty set, not an unknown — the opposite of the metadata case above,
    // where a missing row means "not extracted yet".
    ...(labels !== undefined
      ? {
          labels: labels.map((l) => ({
            app_id: l.appId,
            key: l.key,
            value: l.value,
            // Wire/UI rendering only — storage has no such string.
            label: `${l.appId}/${l.key}`,
          })),
        }
      : {}),
    // Whether *this node* can serve the bytes right now. Always present, so a
    // client never has to discover unreadability by trying and failing —
    // which is what makes archiving safe by construction rather than by every
    // call site remembering not to touch an original.
    ...(availability !== undefined ? { availability } : {}),
    // Keyed by the requested pixel size, carrying the *actual* dimensions of
    // what was chosen. A client that wants to reason about what it got can —
    // it just never has to ask in those terms.
    ...(variants !== undefined
      ? {
          variants: Object.fromEntries(
            Object.entries(variants).map(([target, v]) => [
              target,
              {
                id: v.id,
                type: v.type,
                object_storage_key: v.objectStorageKey,
                width: v.width,
                height: v.height,
                long_edge: v.longEdge,
                ...(v.url ? { url: v.url } : {}),
              },
            ]),
          ),
        }
      : {}),
  };
}

/**
 * Batch-load labels for a page of records — one primary-key-prefix seek with
 * an IN-list, the same shape `loadMetadataForPage` uses.
 *
 * Unlike metadata, this does **not** filter by the caller's grants per label.
 * Any app that can read the record's type sees every app's labels on it; the
 * records reaching this function have already passed that gate. Hiding who
 * asserted what would defeat the point of attributed assertions.
 */
async function loadLabelsForPage(
  db: { getLabelsByRecordIds: (ids: StarkeepId[]) => Promise<Map<StarkeepId, RecordLabel[]>> },
  records: DataRecord[],
  labelApps?: string,
): Promise<Map<StarkeepId, RecordLabel[]>> {
  if (records.length === 0) return new Map();
  const wanted = labelApps
    ? new Set(labelApps.split(",").map((s) => s.trim()).filter(Boolean))
    : null;
  const byId = await db.getLabelsByRecordIds(records.map((r) => r.id));
  if (!wanted) return byId;
  const filtered = new Map<StarkeepId, RecordLabel[]>();
  for (const [id, labels] of byId) {
    filtered.set(id, labels.filter((l) => wanted.has(l.appId)));
  }
  return filtered;
}

/**
 * Below this, archiving costs more than not archiving.
 *
 * Deep Archive bills a 40 KB per-object overhead and a 180-day minimum
 * duration, so a small object frozen is both dearer and slower to read.
 * Strictly worse on both axes — a floor, not a tuning knob. Mirrors the
 * lifecycle rule's own `objectSizeGreaterThan`, and both are asserted, because
 * a disagreement between them would tag objects the rule then ignores (a
 * confusing no-op) or, if the rule's floor were the lower one, freeze things
 * this gate meant to protect.
 */
const ARCHIVE_MIN_OBJECT_BYTES = 1024 * 1024;

/**
 * The archive gate: mark an original eligible for the Deep Archive transition.
 *
 * ## Why the decision is split
 *
 * The **app** asserts its derived ladder is complete, because only it knows
 * what a complete ladder is — the platform must never learn what
 * `image-medium` means, and a platform-side check would have to.
 *
 * The **platform** independently applies the floors and refuses to tag if they
 * fail. So neither side alone can freeze anything: an app that is wrong about
 * its ladder still cannot archive a 200 KB file, and a platform that wanted to
 * be clever still cannot archive a record whose renditions do not exist.
 *
 * ## Why this is a gate rather than an age rule
 *
 * Archiving on age alone would eventually freeze an original whose derivation
 * never succeeded — HEIC on a node with no decoder, say — and that original is
 * the *only* readable form of the record. Gating on confirmed durability
 * instead is also what makes the cloud derivation fallback guaranteed
 * thaw-free: an incomplete original is, by construction, still instantly
 * readable.
 */
/**
 * How long a thawed copy stays readable before lapsing back.
 *
 * A week, so a print session or an export does not re-thaw the same object
 * repeatedly — the retrieval charge is per restore, and the second one buys
 * nothing the first did not.
 */
const RESTORED_COPY_RETENTION_DAYS = 7;

/**
 * Per-app restore budget, enforced before anything is issued.
 *
 * Restore is the one endpoint here where a loop costs real money rather than
 * CPU — and the app most likely to loop is one retrying against a failure it
 * does not understand. Both a count and a byte volume are capped, because
 * either alone is trivially evaded: a thousand small objects and one enormous
 * one are different shapes of the same mistake.
 *
 * Counted over live `restoring` rows rather than a separate ledger, so a
 * restart cannot forget what is already in flight and the window closes on its
 * own as restores complete. The trade-off, accepted: an app that restores
 * steadily and lets each complete is never throttled, which is the intended
 * behaviour — the limit is on *concurrent* commitment, not on lifetime use.
 */
const RESTORE_MAX_CONCURRENT_OBJECTS = 100;
const RESTORE_MAX_CONCURRENT_BYTES = 50 * 1024 ** 3;

async function checkRestoreRateLimit(
  db: DatabaseAdapter,
  appId: string,
  incomingBytes: number,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const inFlight = await db.countRestoringObjects();
  if (inFlight.objectCount + 1 > RESTORE_MAX_CONCURRENT_OBJECTS) {
    return {
      ok: false,
      message:
        `Too many restores already in flight (${inFlight.objectCount}). ` +
        `Wait for some to complete before requesting more.`,
    };
  }
  if (inFlight.bytes + incomingBytes > RESTORE_MAX_CONCURRENT_BYTES) {
    return {
      ok: false,
      message:
        `Restore volume already in flight (${inFlight.bytes} bytes) would be exceeded ` +
        `by this request. Wait for some to complete before requesting more.`,
    };
  }
  void appId;
  return { ok: true };
}

/**
 * The availability of a page of records, as this node sees it.
 *
 * One batched read rather than a HeadObject per record: that would be
 * O(library) on every grid scroll, which is why availability is a maintained
 * fact rather than a computed one. Keys with no stored row take the default.
 */
async function loadAvailabilityForPage(
  db: DatabaseAdapter,
  records: DataRecord[],
): Promise<Map<string, RecordAvailability>> {
  const out = new Map<string, RecordAvailability>();
  if (records.length === 0) return out;
  const keys = [...new Set(records.map((r) => r.objectStorageKey).filter(Boolean))];
  const stored = await db.getAvailability(keys);
  for (const record of records) {
    out.set(record.id, toRecordAvailability(stored.get(record.objectStorageKey)));
  }
  return out;
}

/** Map a stored row (or its absence) onto the API's availability union. */
function toRecordAvailability(row: StoredAvailability | undefined): RecordAvailability {
  if (!row) return DEFAULT_AVAILABILITY;
  switch (row.state) {
    case "archived":
      return {
        state: "archived",
        tier: row.tier ?? "DEEP_ARCHIVE",
        expectedLatencyHours: row.expectedLatencyHours ?? 12,
      };
    case "restoring":
      return {
        state: "restoring",
        readyAt: row.readyAtMs === null ? null : new Date(row.readyAtMs).toISOString(),
      };
    case "absent":
      return { state: "absent" };
    default:
      return { state: "instant" };
  }
}

/**
 * Refuse a read of bytes that are not readable right now.
 *
 * **Never restores implicitly.** A read that quietly triggered a twelve-hour
 * thaw would turn one careless call into a bill and a long wait, and the caller
 * would have no idea it had happened — which is exactly how a future slideshow
 * feature would thaw an entire archive. The 409 carries what a caller needs to
 * decide whether to ask for a restore; asking is a separate, explicit act.
 */
function archivedReadRefusal(availability: RecordAvailability) {
  if (availability.state === "archived") {
    return {
      status: 409,
      body: {
        error: "ObjectArchived",
        availability,
        detail:
          `These bytes are in ${availability.tier} and cannot be read for about ` +
          `${availability.expectedLatencyHours}h. Request a restore explicitly; ` +
          `reads never trigger one.`,
      },
    };
  }
  if (availability.state === "restoring") {
    return {
      status: 409,
      body: {
        error: "ObjectRestoring",
        availability,
        detail: "A restore is already in flight for these bytes.",
      },
    };
  }
  if (availability.state === "absent") {
    return {
      status: 409,
      body: {
        error: "ObjectAbsent",
        availability,
        detail: "This node does not hold these bytes.",
      },
    };
  }
  return null;
}

/**
 * Attach a signed URL to each resolved variant.
 *
 * The URLs ride the record list rather than costing a round trip each, which is
 * the whole reason resolution lives on the list endpoint: a grid that had to
 * presign every tile separately would have given back the hop this design
 * exists to remove. Shared bytes go through the CloudFront chokepoint, which
 * re-checks the grant — so a variant the caller may not read simply arrives
 * without a URL rather than being silently omitted, which would read as "this
 * record has no variant that size".
 */
async function signVariantsForPage(
  appId: string,
  grants: AccessGrants,
  byRecord: Map<StarkeepId, Record<string, ResolvedVariant>>,
): Promise<Map<StarkeepId, Record<string, ResolvedVariant & { url?: string }>>> {
  const out = new Map<StarkeepId, Record<string, ResolvedVariant & { url?: string }>>();
  // One signature per distinct variant, not per (record, target) pair —
  // progressive presentation asks for several sizes and they frequently
  // resolve to the same child.
  const urlByKey = new Map<string, string>();
  for (const [recordId, resolved] of byRecord) {
    const withUrls: Record<string, ResolvedVariant & { url?: string }> = {};
    for (const [target, variant] of Object.entries(resolved)) {
      let url = urlByKey.get(variant.objectStorageKey);
      if (url === undefined) {
        const signed = await signSharedCloudFrontUrl(
          appId,
          variant.objectStorageKey,
          grants,
          VARIANT_URL_TTL_SECONDS,
        );
        if (signed.ok) {
          url = signed.url;
          urlByKey.set(variant.objectStorageKey, url);
        }
      }
      withUrls[target] = url === undefined ? variant : { ...variant, url };
    }
    out.set(recordId, withUrls);
  }
  return out;
}

/**
 * How long an inline variant URL stays valid.
 *
 * Long, deliberately. Keys are content-addressed and the cache policy already
 * excludes the signature from the cache key, so a longer TTL costs nothing in
 * cache efficiency and saves a client re-listing records just to refresh links
 * while a user scrolls.
 */
const VARIANT_URL_TTL_SECONDS = 6 * 60 * 60;

/**
 * Batch-load per-category metadata for a page of records so the list endpoint
 * can embed it (opt-in via ?include=metadata) instead of forcing an N+1
 * per-record metadata fan-out on the client. Records are grouped by category
 * and read one `getMetadataByIds` call per represented category (one call for a
 * homogeneous photo list). Categories the caller can't read, and the
 * metadata-less "other" category, are skipped.
 */
async function loadMetadataForPage(
  db: { getMetadataByIds: (category: string, ids: StarkeepId[]) => Promise<Map<StarkeepId, MetadataRow>> },
  grants: AccessGrants,
  records: DataRecord[],
): Promise<Map<StarkeepId, MetadataRow>> {
  const idsByCategory = new Map<string, StarkeepId[]>();
  for (const r of records) {
    const category = typeCategory(r.type);
    if (category === "other" || !canReadCategory(grants, category)) continue;
    let ids = idsByCategory.get(category);
    if (!ids) idsByCategory.set(category, (ids = []));
    ids.push(r.id);
  }
  const byId = new Map<StarkeepId, MetadataRow>();
  for (const [category, ids] of idsByCategory) {
    for (const [id, row] of await db.getMetadataByIds(category, ids)) byId.set(id, row);
  }
  return byId;
}

/**
 * Resolve a batch of requested label writes into adapter rows, or an error.
 *
 * The `SELECT id, type` here is the part the single-statement upsert hides,
 * and it is very likely the dominant cost of a bulk labelling job — the thing
 * to measure first if one is slow. The batch size that binds it is the same
 * 3,000 as the write: an IN-list that large is fine, but it is not free.
 */
async function planCloudLabelWrites(
  db: DatabaseAdapter,
  grantClient: DatabaseClient,
  grants: AccessGrants,
  appId: string,
  entries: Array<{ recordId: StarkeepId; key: string; value?: string }>,
) {
  const ids = [...new Set(entries.map((e) => e.recordId))];
  const found = await db.query({
    filters: [
      { field: "id", operator: "in", value: ids },
      { field: "deletedAt", operator: "isNull" },
    ],
    limit: ids.length,
  });
  return planLabelWrites({
    entries,
    recordTypes: new Map(found.records.map((r) => [r.id as string, r.type])),
    declaredKeys: await loadDeclaredLabelKeys(grantClient, appId),
    // A read grant is enough — see planLabelWrites for why labelling does not
    // require readwrite.
    canReadType: (type) => canRead(grants, type),
    existingValues: await loadAppLabelValueSets(db, appId, ids),
  });
}

// ---------------------------------------------------------------------------
// Cloud exclusion (`starkeep/no-cloud`)
// ---------------------------------------------------------------------------

/**
 * The AWS storage class **every** write lands in, whatever its declared intent.
 *
 * A constant rather than a function, and the reason is now settled rather than
 * pending. An earlier version was a function taking the intent, on the
 * assumption that `archive` would eventually branch. It does not, and it should
 * not: the transition to Deep Archive is gated on the record's ladder being
 * confirmed complete *and* on a hold period, neither of which is known at write
 * time. Freezing on write would freeze originals whose renditions do not exist
 * yet — exactly when the original is the only readable form of the record.
 *
 * So the split lives entirely in the object's tags, and the lifecycle rule
 * (media plan item 18) is what acts on them. A function pretending to branch
 * invited someone to add the branch here, which is the one place it must never
 * be.
 *
 * Intelligent-Tiering rather than Standard because its *automatic* tiers are
 * all millisecond-latency, so cold objects get cheaper on their own without
 * breaking the `instant` promise. That depends on the bucket never enabling
 * I-T's asynchronous archive tiers — an object in DEEP_ARCHIVE_ACCESS exists
 * and cannot be read — which the installer asserts.
 */
const WRITE_STORAGE_CLASS = "INTELLIGENT_TIERING";

/** Label namespace for platform-level record constraints. */
const STARKEEP_LABEL_APP_ID = "starkeep";
/** Record label forbidding these bytes from reaching cloud storage. */
const NO_CLOUD_LABEL_KEY = "no-cloud";

const NO_CLOUD_REFUSAL =
  "This record is marked starkeep/no-cloud; its bytes may not be written to cloud storage.";

/**
 * True when a live record at this object key is marked `starkeep/no-cloud`.
 *
 * The residency decision on the cloud node elides such a record's blob, but a
 * fetch-time decision cannot stop an inbound *push* — so without this, any node
 * could upload the bytes and the constraint would be advisory. A guarantee that
 * only one side of a transfer enforces is not a guarantee.
 *
 * Keys are content-addressed, so two records can legitimately share one. Any
 * one of them saying no-cloud is enough to refuse: the exclusion is about the
 * *bytes*, and there is no way to store them for one record and not the other.
 */
async function keyIsCloudExcluded(db: DatabaseAdapter, objectStorageKey: string): Promise<boolean> {
  const found = await db.query({
    filters: [
      { field: "objectStorageKey", operator: "eq", value: objectStorageKey },
      { field: "deletedAt", operator: "isNull" },
    ],
    limit: 100,
  });
  if (found.records.length === 0) return false;

  const byId = await db.getLabelsByRecordIds(found.records.map((r) => r.id));
  for (const labels of byId.values()) {
    for (const l of labels) {
      if (l.deletedAt) continue;
      if (l.appId === STARKEEP_LABEL_APP_ID && l.key === NO_CLOUD_LABEL_KEY) return true;
    }
  }
  return false;
}

/**
 * This app's live values per `(record, key)`, for the value-cardinality cap.
 *
 * A second batched read on the write path, and what makes the cap a cap: counted
 * over the batch alone it is cleared by sending 32 values repeatedly, which is
 * exactly the smuggling channel a per-key value cap exists to close.
 *
 * Tombstoned rows are skipped — a retracted value frees its slot, and counting
 * it would make a key that has been edited enough times permanently unwritable.
 */
async function loadAppLabelValueSets(
  db: DatabaseAdapter,
  appId: string,
  recordIds: StarkeepId[],
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (recordIds.length === 0) return out;
  for (const labels of (await db.getLabelsByRecordIds(recordIds)).values()) {
    for (const l of labels) {
      if (l.appId !== appId || l.deletedAt) continue;
      const k = labelValueSetKey(l.recordId, l.key);
      let set = out.get(k);
      if (!set) out.set(k, (set = new Set()));
      set.add(l.value);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * One S3 event notification record, in the shape S3 actually delivers.
 *
 * Typed structurally rather than imported from the SDK because this Lambda's
 * bundle is size-sensitive and the fields consumed are four.
 */
interface S3EventRecord {
  eventName?: string;
  eventTime?: string;
  s3?: { object?: { key?: string } };
  // Present on lifecycle-transition and restore events.
  glacierEventData?: { restoreEventData?: { lifecycleRestorationExpiryTime?: string } };
  lifecycleEventData?: { transitionEventData?: { destinationStorageClass?: string } };
}

interface S3EventEnvelope {
  Records?: S3EventRecord[];
}

/**
 * True when this invocation is an S3 notification rather than an HTTP request.
 *
 * The same Lambda serves both because the alternative — a second function — is
 * a second deployment, a second role, and a second place for the availability
 * vocabulary to drift out of step with the endpoint that reads it.
 */
function isS3Event(event: unknown): event is S3EventEnvelope {
  const records = (event as S3EventEnvelope | undefined)?.Records;
  return Array.isArray(records) && records.length > 0 && "s3" in (records[0] ?? {});
}

/**
 * Apply S3 notifications to stored availability.
 *
 * **This is what makes `availability` mean anything.** Without it every record
 * reports whatever it was written as, forever — so an archived original would
 * still claim to be instantly readable and the 409 that protects callers would
 * never fire.
 *
 * Failures are logged and swallowed per record rather than failing the batch: a
 * malformed or unrecognized notification must not cause S3 to redeliver the
 * whole batch indefinitely, and the daily reconcile is the backstop for
 * anything genuinely missed.
 */
export async function handleS3Availability(
  event: S3EventEnvelope,
  db: DatabaseAdapter,
  storage?: ObjectStorageAdapter,
): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;
  const inventoryManifests: string[] = [];

  for (const record of event.Records ?? []) {
    try {
      const rawKey = record.s3?.object?.key;
      if (!rawKey) {
        skipped += 1;
        continue;
      }
      // S3 URL-encodes keys in notifications, and ours contain slashes.
      const objectStorageKey = decodeURIComponent(rawKey.replace(/\+/g, " "));
      const observedAtMs = record.eventTime ? Date.parse(record.eventTime) : Date.now();

      // An inventory report landing is an ObjectCreated under the reserved
      // prefix, not an availability event about that object. Keyed on the
      // checksum file specifically: S3 writes data files first and the checksum
      // last, so anything else would read a partial report.
      if (
        objectStorageKey.startsWith(INVENTORY_PREFIX) &&
        objectStorageKey.endsWith("manifest.checksum")
      ) {
        inventoryManifests.push(objectStorageKey);
        continue;
      }

      const kind = eventKindOf(record.eventName ?? "");
      if (!kind) {
        skipped += 1;
        continue;
      }

      const expiry =
        record.glacierEventData?.restoreEventData?.lifecycleRestorationExpiryTime;
      const observation = observationFor({
        kind,
        objectStorageKey,
        observedAtMs,
        ...(record.lifecycleEventData?.transitionEventData?.destinationStorageClass
          ? {
              storageClass:
                record.lifecycleEventData.transitionEventData.destinationStorageClass,
            }
          : {}),
        ...(expiry ? { restoredUntilMs: Date.parse(expiry) } : {}),
      });
      if (!observation) {
        skipped += 1;
        continue;
      }

      // Out-of-order delivery is normal, so the stored observation time decides
      // rather than arrival order.
      const stored = (await db.getAvailability([objectStorageKey])).get(objectStorageKey);
      if (!shouldReplace(stored ?? null, observation)) {
        skipped += 1;
        continue;
      }
      await db.putAvailability(observation);
      applied += 1;
    } catch (err) {
      // Swallowed deliberately: a poison record must not make S3 redeliver the
      // batch forever, and the reconcile catches anything genuinely lost.
      console.warn(`[availability] skipping event: ${(err as Error).message}`);
      skipped += 1;
    }
  }

  return { applied, skipped };
}

/**
 * Where inventory reports land. Must match the installer's `INVENTORY_PREFIX`.
 *
 * A drift here is silent in the worst way: reports accumulate, nothing ingests
 * them, and availability quietly has no backstop while appearing to have one.
 */
const INVENTORY_PREFIX = "_starkeep/inventory/";

/**
 * Ingest a daily S3 Inventory report and correct availability from it.
 *
 * The backstop for events that were never delivered. Event delivery is
 * at-least-once and a poison record is deliberately swallowed rather than
 * making S3 redeliver a batch forever — both right, and both meaning something
 * can be lost. Without this a record stays wrong indefinitely, and the
 * wrongness is invisible until somebody tries to read it.
 *
 * Only the manifest's *checksum file* triggers this. S3 writes the data files
 * first and `manifest.checksum` last, so keying on it is what guarantees the
 * data files are complete — reacting to a data file directly would read a
 * partial report.
 */
async function ingestInventoryReport(
  manifestKey: string,
  db: DatabaseAdapter,
  storage: ObjectStorageAdapter,
): Promise<{ applied: number; vanished: number; probes: number; unexpected: number }> {
  // manifest.checksum sits beside manifest.json in the same "run" directory.
  const manifestJsonKey = manifestKey.replace(/manifest\.checksum$/, "manifest.json");
  const manifestBytes = await storage.get(manifestJsonKey);
  if (!manifestBytes) {
    console.warn(`[availability] inventory manifest missing at ${manifestJsonKey}`);
    return { applied: 0, vanished: 0, probes: 0, unexpected: 0 };
  }

  const manifest = JSON.parse(Buffer.from(manifestBytes.data).toString("utf8")) as {
    creationTimestamp?: string;
    fileSchema?: string;
    files?: Array<{ key: string }>;
  };
  // The snapshot's own time, not now. A report generated hours ago must not
  // overwrite an event that happened since, and the newer-wins rule can only
  // apply that if the snapshot time travels with the observations.
  const snapshotAtMs = manifest.creationTimestamp
    ? Number(manifest.creationTimestamp)
    : Date.now();

  // The column order is declared per-report rather than fixed, so it is read
  // from the manifest instead of assumed. Assuming it is how a schema change
  // silently reinterprets StorageClass as a size.
  const columns = (manifest.fileSchema ?? "").split(",").map((c) => c.trim());
  const keyIndex = columns.indexOf("Key");
  const classIndex = columns.indexOf("StorageClass");
  const tierIndex = columns.indexOf("IntelligentTieringAccessTier");
  if (keyIndex < 0 || classIndex < 0) {
    console.warn(`[availability] inventory schema lacks Key/StorageClass: ${manifest.fileSchema}`);
    return { applied: 0, vanished: 0, probes: 0, unexpected: 0 };
  }

  const rows: InventoryRow[] = [];
  for (const file of manifest.files ?? []) {
    const data = await storage.get(file.key);
    if (!data) continue;
    const text = await gunzipToString(Buffer.from(data.data));
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const cells = parseCsvLine(line);
      const rawKey = cells[keyIndex];
      if (!rawKey) continue;
      rows.push({
        // Inventory URL-encodes keys, and ours contain slashes.
        objectStorageKey: decodeURIComponent(rawKey),
        storageClass: cells[classIndex] ?? "STANDARD",
        ...(tierIndex >= 0 && cells[tierIndex] ? { intelligentTieringAccessTier: cells[tierIndex]! } : {}),
      });
    }
  }

  const storedRows = await db.getAvailability(rows.map((r) => r.objectStorageKey));
  const result = reconcileAvailability({
    rows,
    stored: new Map(
      [...storedRows.entries()].map(([k, v]) => [
        k,
        {
          objectStorageKey: k,
          state: v.state,
          readyAtMs: v.readyAtMs,
          restoredUntilMs: v.restoredUntilMs,
          observedAtMs: v.observedAtMs,
        },
      ]),
    ),
    snapshotAtMs,
    nowMs: Date.now(),
  });

  for (const observation of result.observations) await db.putAvailability(observation);
  for (const key of result.vanished) {
    await db.putAvailability(vanishedObservation(key, snapshotAtMs));
  }

  // A restore whose completion event was lost stays `restoring` forever unless
  // something probes it. The set is bounded by outstanding restores, not by
  // library size, which is what makes checking every day affordable.
  for (const key of result.needsRestoreProbe) {
    const facts = await storage.stat(key);
    if (!facts) continue;
    await db.putAvailability({
      objectStorageKey: key,
      state: facts.availability.state === "restoring" ? "restoring" : facts.availability.state,
      tier: facts.storageClass,
      expectedLatencyHours:
        facts.availability.state === "archived" ? facts.availability.expectedLatencyHours : null,
      readyAtMs: null,
      restoredUntilMs: null,
      observedAtMs: Date.now(),
    });
  }

  if (result.unexpectedlyArchived.length > 0) {
    // Reported, never silently corrected: nothing here can un-archive an
    // object, and the interesting question is which rule put it there.
    console.error(
      `[availability] ${result.unexpectedlyArchived.length} object(s) archived that should be ` +
        `instantly readable: ${result.unexpectedlyArchived.slice(0, 10).join(", ")}`,
    );
  }

  return {
    applied: result.observations.length,
    vanished: result.vanished.length,
    probes: result.needsRestoreProbe.length,
    unexpected: result.unexpectedlyArchived.length,
  };
}

async function gunzipToString(buf: Buffer): Promise<string> {
  const { gunzip } = await import("node:zlib");
  return new Promise((resolve, reject) => {
    gunzip(buf, (err, out) => (err ? reject(err) : resolve(out.toString("utf8"))));
  });
}

/**
 * Minimal CSV line parser for inventory rows.
 *
 * S3 quotes every field and escapes embedded quotes by doubling them. A split
 * on commas would break on any key containing one — which object keys may,
 * and ours would if a filename did.
 */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else inQuotes = false;
      } else current += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      cells.push(current);
      current = "";
    } else current += ch;
  }
  cells.push(current);
  return cells;
}

function eventKindOf(eventName: string): AvailabilityEventKind | null {
  if (eventName.startsWith("LifecycleTransition")) return "transition";
  if (eventName.startsWith("ObjectRestore:Completed")) return "restore-completed";
  if (eventName.startsWith("ObjectRestore:Delete")) return "restore-expired";
  if (eventName.startsWith("ObjectRemoved")) return "removed";
  return null;
}

export async function handler(event: APIGatewayEvent, context: LambdaContext) {
  // S3 notifications arrive at the same function as HTTP requests, so the shape
  // has to be discriminated before anything reads `requestContext` — which an
  // S3 event does not have, and which would throw before any of the routing
  // below ran.
  //
  // Handled first and returned early: an availability event has no subject, no
  // grants, and no app id, so none of the per-app machinery below applies to it.
  if (isS3Event(event as unknown)) {
    // Written as Starkeep Drive — the standing cloud-write identity for shared
    // record custody. Availability is a fact about shared blobs, so Drive is
    // already the role that may write it, and the Lambda's own execution role
    // deliberately has no data-plane access of its own.
    const creds = await getAppCreds(
      DRIVE_APP_ID,
      getAccountId(context.invokedFunctionArn),
    );
    const { db, storage } = makeAdapters(DRIVE_APP_ID, creds);
    try {
      const result = await handleS3Availability(
        event as unknown as S3EventEnvelope,
        db,
        storage,
      );
      // Returned in the HTTP shape even though nothing reads it: an
      // S3-triggered invocation's return value is discarded, and keeping one
      // return type keeps every caller and test from having to narrow a union
      // they will never see the other half of.
      return { statusCode: 200, body: JSON.stringify(result) };
    } finally {
      await db.close();
    }
  }

  // Track every DB client opened during this request so we can close them in
  // the finally below. Leaving clients open across Lambda freeze/thaw causes
  // their underlying TCP socket to fire 'error' on a later invocation, which
  // — combined with pg.Client's emit-or-throw default — has killed workers
  // mid-handler and made API Gateway return a default 500.
  const toClose: Array<() => Promise<void>> = [];
  try {
    const method = event.requestContext.http.method.toUpperCase();
    const rawPath = event.rawPath;

    if (method === "OPTIONS") {
      return { statusCode: 200, body: "" };
    }

    // Unauthenticated health check — no app role needed
    if (method === "GET" && rawPath === "/health") {
      return ok({ status: "ok" });
    }

    // All other routes require /apps/{appId}/...
    const parsed = parseAppPath(rawPath);
    if (!parsed) return clientErr("Not found", 404);
    const { appId, subPath } = parsed;

    // HMAC verification gate. Every /apps/{appId}/* route (sync exchange,
    // /data/*, /files/*, /app-data/*, /health) is HMAC-signed by the caller;
    // signatures are checked against the per-app SecureString in SSM. Path-
    // trust without a signature would let any cross-app caller use another
    // app's role-power simply by changing the URL.
    const bodyBytes = event.body
      ? (event.isBase64Encoded
        ? Buffer.from(event.body, "base64")
        : Buffer.from(event.body, "utf8"))
      : Buffer.alloc(0);
    const normalizedHeaders: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(event.headers ?? {})) {
      if (typeof value === "string") normalizedHeaders[key.toLowerCase()] = value;
    }

    // Two callers, two primitives, one message. A *device* presents an Ed25519
    // signature over the same bytes an app HMACs; a server presents the HMAC.
    // The device branch is taken on the presence of the device id header and
    // never falls back to the HMAC path — a device whose key is unknown or
    // revoked must be denied, not given a second chance at a shared secret it
    // should not have.
    const deviceId = normalizedHeaders["x-starkeep-device-id"];
    if (deviceId) {
      const device = await loadDevicePublicKey(deviceId);
      if (!device) {
        return clientErr("Unknown or revoked device", 401);
      }
      const deviceCheck = validateDeviceSignature(
        appId,
        method,
        subPath,
        normalizedHeaders,
        bodyBytes,
        device,
      );
      if (!deviceCheck.ok) {
        return clientErr(deviceCheck.message, deviceCheck.status);
      }
      // The app must still exist — a device may only act as an installed app,
      // so a typo'd or uninstalled appId is rejected here rather than reaching
      // a role assumption for something that was never provisioned.
      if (!(await loadAppHmacSecret(appId))) {
        return clientErr(`Unknown app: ${appId}`, 401);
      }
      // No end-user token is required on this branch, and that is not an
      // oversight or a carve-out. A registered device key IS an end-user
      // credential: admin-web writes it against a named Cognito userId at
      // pairing time (see CachedDeviceKey.userId), so the signature already
      // names the person. The requirement below is the same requirement in the
      // other of its two shapes.
    } else {
      const hmacSecret = await loadAppHmacSecret(appId);
      if (!hmacSecret) {
        return clientErr(`Unknown app: ${appId}`, 401);
      }
      const hmacCheck = validateAppHmac(
        appId,
        method,
        subPath,
        normalizedHeaders,
        bodyBytes,
        hmacSecret,
      );
      if (!hmacCheck.ok) {
        return clientErr(hmacCheck.message, hmacCheck.status);
      }

      // The HMAC says which app is calling. This says a real person is behind
      // it.
      //
      // The 2026-06-11 decision that "the data plane identifies the app, not
      // the end user" was right about *authorization* — the app's grants still
      // decide what it may touch, and nothing here changes that — and was read
      // as licence to check nothing about the user at all. So nothing verified
      // that an app was conducting the business it was handed, and an
      // unauthenticated browser could drive an app's credential straight
      // through this gate.
      //
      // There is no exemption. Every caller already holds one of the two
      // shapes: cloud app compute mints an ID token from the session cookie,
      // the local sync supervisor already refuses to run without a live one,
      // and a paired device presents the signature handled above. Nothing an
      // app puts in its own manifest opts out.
      //
      // /health is not a data path, so it stays reachable — a liveness check
      // that requires a signed-in user cannot tell "down" from "signed out".
      if (!(method === "GET" && subPath === "/health")) {
        const userToken = normalizedHeaders["x-starkeep-user-token"];
        if (!userToken) {
          return clientErr("Missing X-Starkeep-User-Token", 401);
        }
        const poolCfg = userPoolConfig();
        if (!poolCfg) {
          // Refusing beats admitting: a deployment with no pool configured
          // cannot verify anyone, and treating that as "allow" would turn a
          // misconfiguration into an open data plane.
          console.error("[api-handler] no user pool configured — cannot verify end user");
          return clientErr("End-user verification unavailable", 503);
        }
        const claims = await verifyUserToken(userToken, poolCfg);
        if (!claims) {
          return clientErr("Invalid or expired end-user token", 401);
        }
      }
    }

    const accountId = getAccountId(context.invokedFunctionArn);
    const creds = await getAppCreds(appId, accountId);
    const { db, storage, clientFactory, auroraEndpoint, region } = makeAdapters(appId, creds);

    await db.init();
    toClose.push(() => db.close());

    // Per-type read/write enforcement on shared.records. DSQL has no RLS and
    // the table is shared across every type, so we load the caller app's
    // grants once per request and gate both the records and sync paths below.
    // Also seed the cloud HLC clock from the highest cloud-stamped timestamp
    // visible on this request — same connection, one extra query.
    //
    // The client is request-scoped, not scoped to these two loads: the label
    // paths below (`/data/label-keys`, and `loadDeclaredLabelKeys` on the
    // write path) query it too. Closing it here instead left every one of
    // those querying a closed client — "Client was closed and is not
    // queryable", a 500 on the whole cloud label plane, invisible to suites
    // whose fake client keeps answering after `end()`.
    const grantClient = await clientFactory.createClient({ hostname: auroraEndpoint, region });
    toClose.push(() => grantClient.end());
    const grants: AccessGrants = await loadAccessGrants(grantClient, appId);
    const clock: HLCClock = await makeCloudClock(grantClient);

    const query = event.queryStringParameters ?? {};

    // Lazy per-request app-syncable source: needed by both /sync/exchange (the
    // per-app channel, not Drive) and /app-data/*. Build at most once; both
    // call sites share the same DSQL connection. The source's pg client gets
    // closed via toClose in the finally below.
    let appSyncableSource:
      | Awaited<ReturnType<typeof buildAppSyncableSource>>
      | null = null;
    async function getAppSyncableSource() {
      if (!appSyncableSource) {
        appSyncableSource = await buildAppSyncableSource(clientFactory, auroraEndpoint, region);
        toClose.push(() => appSyncableSource!.client.end());
      }
      return appSyncableSource;
    }

    // Lazy per-request app-specific view used by /app-data/*. Mirrors the
    // local-data-server's appSpecificFactory wiring (apps/local-data-server/
    // server.ts:429-439) — same shared-space-api factory, DSQL applier instead
    // of SQLite, S3 storage instead of local.
    //
    // We deliberately do NOT pass buildFileUrl: the factory's fileUrl() is
    // synchronous, but S3 presigning is async, so the GET /app-data/files
    // route below calls storage.getSignedUrl directly after the manifest gate.
    let appSpecificView: AppSpecificOperations | null | undefined;
    async function getAppSpecificView(): Promise<AppSpecificOperations | null> {
      if (appSpecificView !== undefined) return appSpecificView;
      const source = await getAppSyncableSource();
      const factory = createAppSpecificFactory({
        namespace: source.namespaces,
        applier: source.applier,
        fileStorage: storage,
        clock,
      });
      appSpecificView = factory({ subjectType: "app", subjectId: appId });
      return appSpecificView;
    }

    // Clamp a requested presigned-URL TTL (seconds) to the remaining STS
    // session lifetime minus a 30s safety buffer. Presigned URLs signed with
    // session credentials stop working when the session expires — capping
    // expiresIn here ensures the URL never outlives the credentials.
    function clampPresignExpiresIn(requested: number): number {
      const remainingSec = Math.floor((creds.expiresAt - Date.now()) / 1000) - 30;
      return Math.max(1, Math.min(requested, remainingSec));
    }

    // GET /apps/{appId}/health — app-scoped health check
    if (method === "GET" && subPath === "/health") {
      const dbHealthy = await db.healthCheck();
      const storageHealthy = await storage.healthCheck();
      return ok({ status: dbHealthy && storageHealthy ? "ok" : "degraded", db: dbHealthy, storage: storageHealthy });
    }

    // GET /apps/{appId}/data/types
    if (method === "GET" && subPath === "/data/types") {
      if (!grants.allAccess && grants.readableTypes.size === 0) return ok({ types: [], total: 0 });
      const filters: Filter[] = [{ field: "deletedAt", operator: "isNull" }];
      // Drive (allAccess) scans every type; others are constrained to their
      // readable extensions.
      if (!grants.allAccess) {
        filters.unshift({ field: "type", operator: "in", value: [...grants.readableTypes] });
      }
      const result = await db.query({ filters, limit: 10000 });
      const counts = new Map<string, number>();
      for (const record of result.records) {
        counts.set(record.type, (counts.get(record.type) ?? 0) + 1);
      }
      const types = Array.from(counts.entries()).map(([record_type, count]) => ({ record_type, count }));
      return ok({ types, total: result.records.length });
    }

    // GET /apps/{appId}/data/records
    if (method === "GET" && subPath === "/data/records") {
      const type = query["type"];
      const limit = Math.min(parseInt(query["limit"] ?? "50", 10), 500);
      const cursor = query["cursor"];
      const updatedAfter = query["updated_after"];
      // Opt-in enrichment: `include` is a comma list, so `labels` joins
      // `metadata` in it rather than introducing a per-feature boolean.
      const include = (query["include"] ?? "").split(",").map((s) => s.trim());
      const includeMetadata = include.includes("metadata");
      const includeLabels = include.includes("labels");
      const labelApps = query["labelApps"];
      const labelFilter = query["label"];
      const labelValue = query["labelValue"];

      if (labelValue !== undefined && labelFilter === undefined) {
        return clientErr("labelValue requires label", 400);
      }

      // `parentId=<id>` restricts to that record's children; `parentId=none`
      // restricts to records that have no parent at all. Two questions the
      // resize path used to answer by listing the whole library and filtering
      // client-side — which was also silently capped at whatever `limit` the
      // caller passed, so on a large library it answered them wrongly.
      const parentIdParam = query["parentId"];
      const parentFilter: Filter | null =
        parentIdParam === undefined
          ? null
          : parentIdParam === "none"
            ? { field: "parentId", operator: "isNull" }
            : { field: "parentId", operator: "eq", value: parentIdParam };

      // `notLabel=<appId>/<key>` excludes records carrying that label at any
      // value. This is what lets the grid page originals server-side: with a
      // rendition label on every derived child, a 60k-item library is 300k+
      // records, and a page that mixes them is a page the client cannot use.
      const notLabelParam = query["notLabel"];
      let excludeLabel: { appId: string; key: string } | undefined;
      if (notLabelParam !== undefined) {
        const ref = parseLabelRef(notLabelParam);
        if (!ref) {
          return clientErr(
            `notLabel must be of the form "<appId>/<key>" (got "${notLabelParam}")`,
            400,
          );
        }
        excludeLabel = { appId: ref.appId, key: ref.key };
      }

      // `variant=<appId>/<key>&variantLongEdge=400,1280` — resolve, per record,
      // which derived child best answers each requested pixel size.
      //
      // Expressed generically over child records, a label key and the
      // width/height columns, so the platform never learns what any particular
      // size class is. That is what lets the ladder be respecified without a
      // client change, and what lets any image-granted app get the same
      // resolution rather than reimplementing it.
      const variantParam = query["variant"];
      const variantLongEdgeParam = query["variantLongEdge"];
      let variantLabel: { appId: string; key: string } | undefined;
      let variantTargets: number[] = [];
      if (variantParam !== undefined || variantLongEdgeParam !== undefined) {
        if (variantParam === undefined || variantLongEdgeParam === undefined) {
          // Either alone is meaningless, and answering it as though it were
          // valid would silently return no variants — which reads as "this
          // record has none" rather than "you asked wrongly".
          return clientErr("variant and variantLongEdge must be given together", 400);
        }
        const ref = parseLabelRef(variantParam);
        if (!ref) {
          return clientErr(
            `variant must be of the form "<appId>/<key>" (got "${variantParam}")`,
            400,
          );
        }
        const parsed = parseVariantLongEdges(variantLongEdgeParam);
        if (!parsed.ok) return clientErr(parsed.message, 400);
        variantLabel = { appId: ref.appId, key: ref.key };
        variantTargets = parsed.targets;
      }

      // Per-type read enforcement. An explicit ?type= must be in the caller's
      // readable set; otherwise constrain the scan to readable types.
      if (type !== undefined) {
        if (!canRead(grants, type)) return clientErr("Forbidden", 403);
      } else if (!grants.allAccess && grants.readableTypes.size === 0) {
        return ok({ records: [], hasMore: false, nextCursor: null });
      }

      // The reverse-label query is its own access path with its own order and
      // its own cursor; hydration and rendering below are shared.
      if (labelFilter !== undefined) {
        const ref = parseLabelRef(labelFilter);
        if (!ref) {
          return clientErr(
            `label must be of the form "<appId>/<key>" (got "${labelFilter}")`,
            400,
          );
        }
        // The grant filter rides inside the reverse index, so unreadable rows
        // are never materialized and the page comes back full.
        const found = await db.findByLabel({
          appId: ref.appId,
          key: ref.key,
          // Passed through as-is, `""` included: `?labelValue=` asks for bare
          // flags specifically and `?label=…` with no labelValue asks for any
          // value. Collapsing the two — with `|| undefined`, or by testing
          // truthiness anywhere above — turns a flag query into a presence
          // query, which returns a superset and therefore looks like it works.
          value: labelValue,
          readableTypes: grants.allAccess ? undefined : grants.readableTypes,
          limit,
          cursor,
        });

        // Restore the index's order: `query` returns id-ascending, which is
        // not the (value, record_id) order the cursor is keyed on.
        const ids = found.labels.map((l) => l.recordId);
        const byId = new Map<string, DataRecord>();
        if (ids.length > 0) {
          const fetched = await db.query({
            filters: [
              { field: "id", operator: "in", value: ids },
              { field: "deletedAt", operator: "isNull" },
              // Combinable with the label filter, per the plan: "which
              // rendition of *this* record" is one query, not a label scan
              // followed by a client-side parent check.
              ...(parentFilter ? [parentFilter] : []),
            ],
            limit: ids.length,
            ...(excludeLabel ? { excludeLabel } : {}),
          });
          for (const r of fetched.records) byId.set(r.id, r);
        }
        // A label whose record is gone (a delete that raced sync) drops out
        // here — the one thing that can still short a page, and the reason
        // the contract is "page until nextCursor is null". `parentId` and
        // `notLabel` short a page the same way when combined with `label`,
        // for the same reason and with the same remedy.
        const labelled = ids
          .map((id) => byId.get(id))
          .filter((r): r is DataRecord => r !== undefined);

        const metaById = includeMetadata
          ? await loadMetadataForPage(db, grants, labelled)
          : null;
        const labelsById = includeLabels
          ? await loadLabelsForPage(db, labelled, labelApps)
          : null;
        const variantsById = variantLabel
          ? await signVariantsForPage(
              appId,
              grants,
              await loadVariantsForPage(db, labelled, variantLabel, variantTargets),
            )
          : null;
        const availabilityById = await loadAvailabilityForPage(db, labelled);
        return ok({
          records: labelled.map((r) =>
            recordToResponse(
              r,
              metaById ? metaById.get(r.id) ?? null : undefined,
              labelsById ? labelsById.get(r.id) ?? [] : undefined,
              variantsById ? variantsById.get(r.id) ?? {} : undefined,
              availabilityById.get(r.id) ?? DEFAULT_AVAILABILITY,
            ),
          ),
          hasMore: found.hasMore,
          nextCursor: found.nextCursor,
        });
      }

      const filters: Filter[] = [{ field: "deletedAt", operator: "isNull" }];
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
      if (type === undefined && !grants.allAccess) {
        filters.push({ field: "type", operator: "in", value: [...grants.readableTypes] });
      }
      if (parentFilter) filters.push(parentFilter);

      const result = await db.query({
        type,
        filters,
        limit: limit + 1,
        cursor,
        ...(excludeLabel ? { excludeLabel } : {}),
      });
      const hasMore = result.records.length > limit;
      const records = hasMore ? result.records.slice(0, limit) : result.records;
      const metadataById = includeMetadata ? await loadMetadataForPage(db, grants, records) : null;
      const labelsById = includeLabels ? await loadLabelsForPage(db, records, labelApps) : null;
      const variantsById = variantLabel
        ? await signVariantsForPage(
            appId,
            grants,
            await loadVariantsForPage(db, records, variantLabel, variantTargets),
          )
        : null;
      const availabilityById = await loadAvailabilityForPage(db, records);
      return ok({
        records: records.map((r) =>
          recordToResponse(
            r,
            metadataById ? metadataById.get(r.id) ?? null : undefined,
            labelsById ? labelsById.get(r.id) ?? [] : undefined,
            variantsById ? variantsById.get(r.id) ?? {} : undefined,
            availabilityById.get(r.id) ?? DEFAULT_AVAILABILITY,
          ),
        ),
        hasMore,
        nextCursor: hasMore ? records[records.length - 1].id : null,
      });
    }

    // GET /apps/{appId}/data/label-keys[?app=<appId>]
    //
    // The manifest-declared label-key registry. Deliberately NOT filtered by
    // the caller's grants: which keys an app declares is public schema, not
    // user data. Cross-app discoverability is the reason keys are declared in
    // a manifest at all rather than counted at runtime.
    if (method === "GET" && subPath === "/data/label-keys") {
      const filterApp = query["app"];
      let q = postgresCompiler
        .selectFrom("shared.app_label_keys")
        .select(["app_id", "key", "description"])
        .orderBy("app_id", "asc")
        .orderBy("key", "asc");
      if (filterApp) q = q.where("app_id", "=", filterApp);
      const compiled = q.compile();
      const result = await grantClient.query(compiled.sql, [...compiled.parameters]);
      const rows = result.rows as Array<{
        app_id: string;
        key: string;
        description: string | null;
      }>;
      return ok({
        labelKeys: rows.map((r) => ({
          app_id: r.app_id,
          key: r.key,
          label: `${r.app_id}/${r.key}`,
          description: r.description,
        })),
      });
    }

    // POST /apps/{appId}/data/labels — add labels (insert-or-update).
    // Body: { labels: [{ recordId, key, value? }, …] }
    //
    // Adds; does not replace. A key is set-valued, so writing `faces=Bob` where
    // `faces=Alice` already sits leaves both — /data/labels/values is the
    // endpoint that makes a key hold exactly a given set.
    //
    // `appId` is never in the body: it is the authenticated subject, which is
    // what makes squatting another app's namespace unrepresentable rather
    // than merely rejected.
    if (method === "POST" && subPath === "/data/labels") {
      const rawBody = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64").toString("utf8")
        : (event.body ?? "{}");
      const body = JSON.parse(rawBody) as {
        labels?: Array<{ recordId?: string; key?: string; value?: string }>;
      };
      const entries = body.labels;
      if (!Array.isArray(entries) || entries.length === 0) {
        return clientErr("labels must be a non-empty array", 400);
      }
      if (entries.some((e) => !e.recordId || !e.key)) {
        return clientErr("each label needs a recordId and a key", 400);
      }

      const plan = await planCloudLabelWrites(
        db,
        grantClient,
        grants,
        appId,
        entries as Array<{ recordId: StarkeepId; key: string; value?: string }>,
      );
      if (!plan.ok) return clientErr(plan.error, plan.status);

      const hlc = clock.now();
      await db.upsertLabels(plan.writes.map((w) => ({ ...w, appId, hlc })));
      return ok({ written: plan.writes.length });
    }

    // POST /apps/{appId}/data/labels/values — make each key hold exactly
    // `values`.
    // Body: { labels: [{ recordId, key, values: [...] }, …] }
    //
    // The set-valued write: upserts the listed values and tombstones the rest of
    // that key's values on that record, atomically per entry. An empty `values`
    // clears the key. This is what a **single-valued** key uses to update, since
    // a plain add no longer overwrites — "set the count to 4" written as an add
    // leaves `count=3` beside it.
    if (method === "POST" && subPath === "/data/labels/values") {
      const rawBody = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64").toString("utf8")
        : (event.body ?? "{}");
      const body = JSON.parse(rawBody) as {
        labels?: Array<{ recordId?: string; key?: string; values?: unknown }>;
      };
      const entries = body.labels;
      if (!Array.isArray(entries) || entries.length === 0) {
        return clientErr("labels must be a non-empty array", 400);
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
        return clientErr(
          "each entry needs a recordId, a key, and a values array of strings",
          400,
        );
      }
      const normalized = entries.map((e) => ({
        recordId: e.recordId as StarkeepId,
        key: e.key as string,
        // Deduped here: the upsert half is one multi-row statement and cannot
        // touch a row twice on DSQL, and a repeat is the same row anyway.
        values: [...new Set(e.values as string[])],
      }));

      // An entry with no values writes nothing — it only tombstones — so it is a
      // retraction of the whole key and is gated as one: no declared-key check
      // (an uninstalled key's rows must stay reachable by their author) and no
      // record-existence check (clearing a key on a deleted record is a no-op).
      const clears = normalized.filter((e) => e.values.length === 0);
      const sets = normalized.filter((e) => e.values.length > 0);

      const clearPlan = planLabelRetractions(clears);
      if (!clearPlan.ok) return clientErr(clearPlan.error, clearPlan.status);

      // The rest is gated exactly like an add — same key shape, same
      // declared-key check, same record-existence check, same read grant, same
      // value-cardinality cap.
      const plan = await planCloudLabelWrites(
        db,
        grantClient,
        grants,
        appId,
        sets.flatMap((e) =>
          e.values.map((value) => ({ recordId: e.recordId, key: e.key, value })),
        ),
      );
      if (!plan.ok) return clientErr(plan.error, plan.status);

      const typeByRecord = new Map(plan.writes.map((w) => [w.recordId, w.recordType]));
      const hlc = clock.now();
      await db.replaceLabelValues(
        sets.map((e) => ({
          recordId: e.recordId,
          appId,
          key: e.key,
          values: e.values,
          recordType: typeByRecord.get(e.recordId)!,
          hlc,
        })),
      );
      // Omitted `value` — retract every value of the key, which is what an empty
      // `values` asked for.
      await db.retractLabels(
        clearPlan.writes.map((e) => ({
          recordId: e.recordId,
          key: e.key,
          appId,
          hlc,
        })),
      );
      return ok({ replaced: normalized.length });
    }

    // POST /apps/{appId}/data/labels/retract — tombstone labels.
    // Body: { labels: [{ recordId, key, value? }, …] }
    //
    // An omitted `value` retracts **every** value of that key on that record;
    // `value: ""` retracts the bare flag alone.
    if (method === "POST" && subPath === "/data/labels/retract") {
      const rawBody = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64").toString("utf8")
        : (event.body ?? "{}");
      const body = JSON.parse(rawBody) as {
        labels?: Array<{ recordId?: string; key?: string; value?: string }>;
      };
      const entries = body.labels;
      if (!Array.isArray(entries) || entries.length === 0) {
        return clientErr("labels must be a non-empty array", 400);
      }
      if (entries.some((e) => !e.recordId || !e.key)) {
        return clientErr("each retraction needs a recordId and a key", 400);
      }

      // Checks far less than the write path — no declared-key check, no
      // record-existence check, no grant check. See planLabelRetractions.
      const plan = planLabelRetractions(
        entries as Array<{ recordId: StarkeepId; key: string; value?: string }>,
      );
      if (!plan.ok) return clientErr(plan.error, plan.status);

      const hlc = clock.now();
      await db.retractLabels(plan.writes.map((r) => ({ ...r, appId, hlc })));
      return ok({ retracted: plan.writes.length });
    }

    // POST /apps/{appId}/data/records
    //
    // Body (key-ref form):
    //   { type, contentType, contentHash, sizeBytes, fileName?, parentId?,
    //     labels? }
    //
    // The caller PUTs the bytes to S3 via a presigned URL first (see POST
    // /files/presign), then registers the record by content-addressed key.
    if (method === "POST" && subPath === "/data/records") {
      const rawBody = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64").toString("utf8")
        : (event.body ?? "{}");
      const body = JSON.parse(rawBody) as {
        type?: string;
        fileName?: string;
        contentType?: string;
        contentHash?: string;
        sizeBytes?: number;
        parentId?: string;
        labels?: Array<{ key: string; value?: string }>;
      };
      if (!body.type) return clientErr("type is required", 400);
      if (!isKnownType(body.type)) return clientErr(`Unknown type id: ${body.type}`, 400);
      if (!canWrite(grants, body.type)) return clientErr("Forbidden", 403);
      if (!body.contentHash) {
        return clientErr(
          "contentHash is required — PUT the bytes via a presigned URL first, then register the record by content-addressed key",
          400,
        );
      }
      if (!/^[a-f0-9]{64}$/.test(body.contentHash)) {
        return clientErr("contentHash must be a 64-character lowercase hex sha256", 400);
      }
      if (typeof body.sizeBytes !== "number" || !Number.isFinite(body.sizeBytes) || body.sizeBytes < 0) {
        return clientErr("sizeBytes is required and must be a non-negative number", 400);
      }
      const contentHash = body.contentHash;
      const objectStorageKey = dataRecordObjectKey(body.type, contentHash);
      const sizeBytes = body.sizeBytes;
      const exists = await storage.has(objectStorageKey);
      if (!exists) {
        return clientErr(
          "Blob not found at the content-addressed key. PUT it via a presigned URL first.",
          409,
        );
      }

      // The dedup-check + insert is one OCC unit: retry re-reads the dup query
      // so a conflict caused by a concurrent writer re-checks for the duplicate
      // before inserting. A rolled-back attempt commits nothing, so minting a
      // fresh id/timestamp on each attempt cannot leave a duplicate behind.
      // `created` distinguishes a fresh insert (201) from returning an existing
      // duplicate (200).
      const { record, created } = await withOccRetry("POST /data/records", async () => {
        // Record-level dedup: **one object key, at most one live record.**
        //
        // Keys are content-addressed, so two registrations of the same bytes
        // name the same object. Letting both create records would mean the
        // object has two referents — and then deleting either record has to
        // decide whether the bytes may go, which is a refcount the reaper
        // cannot compute cheaply and must never get wrong. Collapsing here is
        // what unblocks it: after this, a key has exactly one record, so
        // "delete the record, delete the object" is sound.
        //
        // Scoped by parent, because the parent edge is part of what the record
        // *is*: the same bytes may legitimately be both a standalone photo and
        // a rendition of something else, and those are different records that
        // happen to share storage. Within one parent (or within the top level),
        // a byte-identical registration is the same thing arriving twice.
        //
        // Idempotent rather than an error. The second arrival is usually a
        // retry, a re-import, or two concurrent derivations of one original —
        // none of which is a mistake the caller can act on, and all of which
        // want the existing record back.
        const dupFilters: Filter[] = [
          { field: "contentHash", operator: "eq", value: contentHash },
          { field: "deletedAt", operator: "isNull" },
        ];
        dupFilters.push(
          body.parentId
            ? { field: "parentId", operator: "eq", value: body.parentId }
            : { field: "parentId", operator: "isNull" },
        );
        const dup = await db.query({ filters: dupFilters, limit: 1 });
        const existing = dup.records[0];
        if (existing) return { record: existing, created: false };

        const now = clock.now();
        const fresh: DataRecord = {
          id: generateId(),
          kind: "data",
          type: body.type!,
          originAppId: appId,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          version: 1,
          contentHash,
          objectStorageKey,
          mimeType: body.contentType ?? null,
          sizeBytes,
          originalFilename: body.fileName ?? null,
          parentId: (body.parentId as DataRecord["parentId"]) ?? null,
        };
        await db.put(fresh);
        return { record: fresh, created: true };
      });

      // Optional labels, written in the same request as the record but NOT the
      // same transaction — see the local-data-server's equivalent for why a
      // transaction would buy nothing durable here. Only on the created path:
      // a dedup hit is somebody else's record and re-labelling it silently
      // would be a surprise.
      if (created && Array.isArray(body.labels) && body.labels.length > 0) {
        const plan = await planCloudLabelWrites(
          db,
          grantClient,
          grants,
          appId,
          body.labels.map((l) => ({ ...l, recordId: record.id })),
        );
        if (!plan.ok) {
          // The record is already written. Report the label failure rather
          // than pretending the whole call failed — the caller can retry just
          // the labels against POST /data/labels.
          return ok(
            {
              error: "InvalidLabelWrite",
              detail: plan.error,
              record: recordToResponse(record),
              recordCreated: true,
            },
            plan.status,
          );
        }
        const labelHlc = clock.now();
        await db.upsertLabels(plan.writes.map((w) => ({ ...w, appId, hlc: labelHlc })));
      }

      return ok({ record: recordToResponse(record) }, created ? 201 : 200);
    }

    // POST /apps/{appId}/data/files?type=<typeId>
    // Writes raw bytes under shared/<typeId>/<shard>/<hash>. The app's IAM
    // role gates which shared/<typeId>/ prefixes it can write — the handler
    // does not re-check the manifest here.
    if (method === "POST" && subPath === "/data/files") {
      const typeId = query["type"];
      if (!typeId) return clientErr("type query param is required", 400);
      // The blob lands at shared/<category>/…, so authorize the derived
      // category. Accept a full Starkeep type id or a bare category id; reject
      // anything else up front rather than letting typeCategory's "other"
      // fallback silently coerce a typo — the caller's "other" grants would then
      // gate a misspelled type, which is a footgun.
      if (!isKnownType(typeId) && !isCategoryId(typeId)) {
        return clientErr(`Unknown type id: ${typeId}`, 400);
      }
      const fileCategory = typeCategory(typeId);
      if (!canWriteCategory(grants, fileCategory)) return clientErr("Forbidden", 403);
      const headers = event.headers ?? {};
      const contentTypeHeader = headers["content-type"] ?? headers["Content-Type"] ?? "application/octet-stream";
      const mimeType = contentTypeHeader.split(";")[0]!.trim();
      const fileBuffer = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64")
        : Buffer.from(event.body ?? "", "binary");
      if (fileBuffer.length === 0) return clientErr("Request body must not be empty", 400);
      if (fileBuffer.length > 20_000_000) return clientErr("File too large (20 MB limit)", 413);
      const hex = createHash("sha256").update(fileBuffer).digest("hex");
      const key = dataRecordObjectKey(typeId, hex);
      // Same refusal as the presign path. Both are blob-write entry points, and
      // guarding only the one the sync engine happens to use would leave the
      // constraint enforceable by convention rather than by the server.
      if (await keyIsCloudExcluded(db, key)) return clientErr(NO_CLOUD_REFUSAL, 403);
      await storage.put(key, fileBuffer, {
        contentType: mimeType,
        // Single-part path (capped at 20 MB above), so a whole-object SHA-256
        // is the right checksum type and S3 rejects a mismatched body.
        checksumSha256: sha256HexToBase64(hex),
      });
      return ok({ key, contentHash: hex, mimeType, sizeBytes: fileBuffer.length });
    }

    // POST /apps/{appId}/files/presign — issue a presigned S3 PUT URL.
    // Body: { key, contentType? }. The local-data-server's HttpObjectStorageAdapter
    // uploads directly to S3 with the returned URL, bypassing API Gateway size limits.
    if (method === "POST" && subPath === "/files/presign") {
      const rawBody = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64").toString("utf8")
        : (event.body ?? "{}");
      const body = JSON.parse(rawBody) as {
        key?: string;
        contentType?: string;
        intent?: string;
      };
      if (!body.key) return clientErr("key is required", 400);
      const check = parseObjectKey(appId, body.key, grants, "write");
      if (!check.ok) return clientErr(check.message, check.status);
      // Declared retrieval intent, in the platform's vocabulary — the app says
      // what latency it can tolerate, not which storage class it wants. An
      // unrecognized value is refused rather than defaulted: silently writing
      // `instant` for a typo'd "archve" costs money quietly, and silently
      // writing `archive` would put bytes behind a 48-hour thaw nobody asked
      // for. Neither failure announces itself.
      if (body.intent !== undefined && !isRetrievalIntent(body.intent)) {
        return clientErr(
          `intent must be one of ${RETRIEVAL_INTENTS.join(", ")} (got "${body.intent}")`,
          400,
        );
      }
      const intent: RetrievalIntent = body.intent ?? DEFAULT_RETRIEVAL_INTENT;
      // Pin the permitted body into the signature. Shared record keys *are*
      // the SHA-256, so the expected checksum is derivable from the key alone —
      // the caller is never asked for it and could not influence it if it
      // tried. S3 then rejects a body that hashes to anything else instead of
      // storing it, which is what turns "the upload returned 200" into
      // "S3 confirmed these bytes are the bytes this key names".
      //
      // App-syncable keys are deliberately not content-addressed, so they get
      // no pin; the helper returns null for them.
      const noCloud = await keyIsCloudExcluded(db, body.key);
      if (noCloud) return clientErr(NO_CLOUD_REFUSAL, 403);

      const contentHash = contentHashFromDataRecordObjectKey(body.key);
      const checksumSha256 = contentHash ? sha256HexToBase64(contentHash) : undefined;
      const tagging = tagsForIntent(intent);
      const url = await storage.getSignedPutUrl!(body.key, {
        expiresIn: 3600,
        ...(body.contentType ? { contentType: body.contentType } : {}),
        ...(checksumSha256 ? { checksumSha256 } : {}),
        // Both are bound into the signature, so the uploader cannot choose a
        // different tier or tag its way into a lifecycle rule it wasn't given.
        storageClass: WRITE_STORAGE_CLASS,
        ...(Object.keys(tagging).length > 0 ? { tagging } : {}),
      });
      // Returned so the uploader can send the mandatory headers without
      // re-deriving them (and without needing to know the checksum encoding
      // differs from the hex contentHash it already holds, or what a storage
      // class even is).
      return ok({
        url,
        ...(checksumSha256 ? { checksumSha256 } : {}),
        intent,
        storageClass: WRITE_STORAGE_CLASS,
        ...(Object.keys(tagging).length > 0 ? { tagging } : {}),
      });
    }

    // GET /apps/{appId}/files/{encodedKey}/presign — presigned S3 GET URL.
    // The caller URL-encodes the storage key, but API Gateway HTTP API
    // normalizes %2F back to "/" before forwarding to Lambda, so the captured
    // segment must allow embedded slashes (object keys are multi-segment, e.g.
    // shared/image/<shard>/<hash>).
    const filePresignGetMatch = subPath.match(/^\/files\/(.+)\/presign$/);
    if (filePresignGetMatch && method === "GET") {
      const key = decodeURIComponent(filePresignGetMatch[1]!);
      const check = parseObjectKey(appId, key, grants, "read");
      if (!check.ok) return clientErr(check.message, check.status);
      const exists = await storage.has(key);
      if (!exists) return clientErr("Not found", 404);
      // Shared bytes → CloudFront signed URL (through the chokepoint); app
      // syncable bytes stay on S3 presign (CloudFront never serves apps/*).
      if (key.startsWith("shared/")) {
        const signed = await signSharedCloudFrontUrl(appId, key, grants, 3600);
        if (!signed.ok) return clientErr(signed.message, signed.status);
        return ok({ url: signed.url });
      }
      const url = await storage.getSignedUrl!(key, { expiresIn: 3600 });
      return ok({ url });
    }

    // GET /apps/{appId}/files/{encodedKey}/stat — the object facts a HEAD
    // already returns: size, stored checksum, storage class, and whether the
    // bytes are readable right now.
    //
    // This exists because a bare existence check is the wrong question for
    // anything that might delete a local copy or promise a caller a successful
    // read: an archived object exists and cannot be read. Same cost as the HEAD
    // below — one HeadObject — so there is no reason to throw the rest away.
    const fileStatMatch = subPath.match(/^\/files\/(.+)\/stat$/);
    if (fileStatMatch && method === "GET") {
      const key = decodeURIComponent(fileStatMatch[1]!);
      const check = parseObjectKey(appId, key, grants, "read");
      if (!check.ok) return clientErr(check.message, check.status);
      const facts = await storage.stat(key);
      if (!facts) return clientErr("Not found", 404);
      return ok(facts);
    }

    // HEAD|DELETE /apps/{appId}/files/{encodedKey} — same multi-segment key
    // handling as the presign route above.
    const fileObjectMatch = subPath.match(/^\/files\/(.+)$/);
    if (fileObjectMatch && method === "HEAD") {
      const key = decodeURIComponent(fileObjectMatch[1]!);
      const check = parseObjectKey(appId, key, grants, "read");
      if (!check.ok) return { statusCode: check.status, body: "" };
      const exists = await storage.has(key);
      return { statusCode: exists ? 200 : 404, body: "" };
    }
    if (fileObjectMatch && method === "DELETE") {
      const key = decodeURIComponent(fileObjectMatch[1]!);
      const check = parseObjectKey(appId, key, grants, "write");
      if (!check.ok) return clientErr(check.message, check.status);
      await storage.delete(key);
      return ok({ ok: true });
    }

    // POST /apps/{appId}/data/records/:id/metadata — write metadata.
    // The calling app does the extraction (e.g. EXIF); the server validates keys
    // against the per-category schema and persists via the database adapter.
    // `typeId` is the record's extension (or a category id); the metadata table
    // is the derived category's. `other` has no metadata table.
    const metadataWriteMatch = subPath.match(/^\/data\/records\/([^/]+)\/metadata$/);
    if (metadataWriteMatch && method === "POST") {
      const recordId = decodeURIComponent(metadataWriteMatch[1]!) as StarkeepId;
      const rawBody = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64").toString("utf8")
        : (event.body ?? "{}");
      const { typeId, metadata } = JSON.parse(rawBody) as { typeId?: string; metadata?: Record<string, unknown> };
      if (!typeId) return clientErr("typeId is required", 400);
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        return clientErr("metadata must be an object", 400);
      }
      // Metadata tables are per-category, so gate on the caller's writable
      // categories (derived from its type grants). PG GRANTs back this up at
      // the per-category metadata table. `typeId` may be a full type id or a
      // bare category id; typeCategory handles both.
      const category = typeCategory(typeId);
      if (!canWriteCategory(grants, category)) return clientErr("Forbidden", 403);
      if (category === "other") {
        return clientErr(`Category "other" has no metadata table`, 400);
      }
      const categoryDef = getCategory(category)!;
      const allowedColumns = new Set(categoryDef.metadataColumns.map((c) => c.name));
      const unknownKeys = Object.keys(metadata).filter((k) => !allowedColumns.has(k));
      if (unknownKeys.length > 0) {
        return clientErr(`Unknown metadata columns: ${unknownKeys.join(", ")}`, 400);
      }
      await db.putMetadata(category, { recordId, ...metadata });
      return ok({ ok: true });
    }

    // GET /apps/{appId}/data/records/:id/metadata/:typeId — read metadata.
    const metadataReadMatch = subPath.match(/^\/data\/records\/([^/]+)\/metadata\/([^/]+)$/);
    if (metadataReadMatch && method === "GET") {
      const recordId = decodeURIComponent(metadataReadMatch[1]!) as StarkeepId;
      const typeId = decodeURIComponent(metadataReadMatch[2]!);
      const category = typeCategory(typeId);
      if (!canReadCategory(grants, category)) return clientErr("Forbidden", 403);
      if (category === "other") return ok({ metadata: null });
      const metadata = await db.getMetadata(category, recordId);
      return ok({ metadata });
    }

    // POST /apps/{appId}/data/records/file-urls — batch signed URLs.
    //
    // Collapses the gallery-style per-photo file-url fan-out (each of which
    // costs its own Lambda invocation) into one request: one records query,
    // then presigns in-process. Per-id semantics match the single file-url
    // route below, except that unknown, deleted, unreadable, and file-less
    // ids are silently omitted from the response instead of failing the
    // whole batch.
    if (subPath === "/data/records/file-urls" && method === "POST") {
      const rawBody = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64").toString("utf8")
        : (event.body ?? "{}");
      const body = JSON.parse(rawBody) as { ids?: unknown; expiresIn?: unknown };
      if (
        !Array.isArray(body.ids) ||
        body.ids.length === 0 ||
        !body.ids.every((id) => typeof id === "string" && id.length > 0)
      ) {
        return clientErr("ids must be a non-empty array of record ids", 400);
      }
      if (body.ids.length > 500) {
        return clientErr("ids must contain at most 500 record ids", 400);
      }
      const ids = [...new Set(body.ids)] as StarkeepId[];
      // Shared bytes are CloudFront-signed with a flat expiry — CloudFront
      // key-pair signatures don't die with the STS session, so the historical
      // STS clamp doesn't apply. The (defensive) S3-presign fallback for any
      // non-shared key still clamps, since those URLs do die with the session.
      const requestedExpiresIn =
        typeof body.expiresIn === "number" && Number.isFinite(body.expiresIn) && body.expiresIn > 0
          ? body.expiresIn
          : 3600;
      const result = await db.query({
        filters: [
          { field: "id", operator: "in", value: ids },
          { field: "deletedAt", operator: "isNull" },
        ],
        limit: ids.length,
      });
      const urls: Record<string, { url: string; mimeType?: string; sizeBytes?: number }> = {};
      await Promise.all(
        result.records
          .filter((r) => canRead(grants, r.type) && r.objectStorageKey)
          .map(async (r) => {
            const key = r.objectStorageKey!;
            let url: string;
            if (key.startsWith("shared/")) {
              // Through the pre-sign revalidation chokepoint. A key whose
              // category the caller can't read (a route/data mismatch) is
              // silently omitted, matching this batch route's per-id semantics.
              const signed = await signSharedCloudFrontUrl(appId, key, grants, requestedExpiresIn);
              if (!signed.ok) return;
              url = signed.url;
            } else {
              url = await storage.getSignedUrl!(key, {
                expiresIn: clampPresignExpiresIn(requestedExpiresIn),
              });
            }
            urls[r.id] = {
              url,
              mimeType: r.mimeType ?? undefined,
              sizeBytes: r.sizeBytes ?? undefined,
            };
          }),
      );
      return ok({ urls, expiresIn: requestedExpiresIn });
    }

    // GET /apps/{appId}/data/records/:id/file-url
    // POST /apps/{appId}/data/records/:id/archive-gate
    //
    // Body: { ladderComplete: boolean }. The caller asserts its derived ladder
    // is complete; this applies the platform's own floors and tags the object
    // only if both agree. Idempotent — re-tagging an already-tagged object is a
    // no-op, which is what makes it safe to call after every derivation pass.
    const archiveGateMatch = subPath.match(/^\/data\/records\/([^/]+)\/archive-gate$/);
    if (archiveGateMatch && method === "POST") {
      const id = decodeURIComponent(archiveGateMatch[1]!) as StarkeepId;
      const record = await db.get(id);
      if (!record || record.deletedAt) return clientErr("Record not found", 404);
      // Write access, not read: this changes how the object is stored, and an
      // app that may only read a record has no business deciding it can be
      // slow to read for everyone else.
      if (!canWrite(grants, record.type)) return clientErr("Forbidden", 403);
      if (!record.objectStorageKey) return clientErr("Record has no attached file", 404);

      const body = event.body
        ? (JSON.parse(
            event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body,
          ) as { ladderComplete?: boolean })
        : {};

      const refusals: string[] = [];
      if (body.ladderComplete !== true) {
        refusals.push(
          "the caller did not assert ladderComplete — an original whose derived " +
            "ladder is incomplete is still the only readable form of the record",
        );
      }
      if (record.sizeBytes <= ARCHIVE_MIN_OBJECT_BYTES) {
        refusals.push(
          `object is ${record.sizeBytes} bytes, at or below the ${ARCHIVE_MIN_OBJECT_BYTES}-byte ` +
            "floor: Deep Archive's per-object overhead and minimum duration make archiving it " +
            "both dearer and slower than leaving it",
        );
      }
      // A record marked no-cloud has no cloud bytes to archive, and tagging one
      // would be asserting something about an object that should not exist.
      if (await keyIsCloudExcluded(db, record.objectStorageKey)) {
        refusals.push("record is marked starkeep/no-cloud");
      }

      if (refusals.length > 0) {
        return ok({ archived: false, refusals });
      }

      await storage.setTags(record.objectStorageKey, {
        [INTENT_TAG_KEY]: "archive",
        [LADDER_TAG_KEY]: LADDER_TAG_COMPLETE,
      });
      // Tagged, not transitioned. The lifecycle rule performs the transition
      // after `archiveHoldDays`, which buys a week to catch a derivation bug
      // before the input is behind a 48-hour thaw.
      return ok({ archived: false, tagged: true, refusals: [] });
    }

    // POST /apps/{appId}/data/records/:id/restore
    //
    // Restoring is a real feature, not an error path — and it is the *only* way
    // archived bytes become readable. Reads never trigger one, so this endpoint
    // is where the cost and the wait become someone's decision rather than
    // their discovery.
    //
    // Two-step by design. Without `confirm`, it returns an estimate and does
    // nothing; with it, the restore is issued. A single-step endpoint would
    // make the numbers something a caller learns *after* committing to them.
    const restoreMatch = subPath.match(/^\/data\/records\/([^/]+)\/restore$/);
    if (restoreMatch && method === "POST") {
      const id = decodeURIComponent(restoreMatch[1]!) as StarkeepId;
      const record = await db.get(id);
      if (!record || record.deletedAt) return clientErr("Record not found", 404);
      // A read grant is enough to *ask*: restoring does not change the bytes,
      // and requiring write access would mean a read-only app could see that a
      // record is archived and have no way to act on it.
      if (!canRead(grants, record.type)) return clientErr("Forbidden", 403);
      if (!record.objectStorageKey) return clientErr("Record has no attached file", 404);

      const body = event.body
        ? (JSON.parse(
            event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body,
          ) as { confirm?: boolean; tier?: string })
        : {};

      const current = toRecordAvailability(
        (await db.getAvailability([record.objectStorageKey])).get(record.objectStorageKey),
      );
      if (current.state === "instant") {
        // Not an error: the caller asked for something that has already
        // happened, which is the ordinary outcome of two clients racing on one
        // archived record.
        return ok({ alreadyReadable: true, availability: current });
      }
      if (current.state === "restoring") {
        return ok({ alreadyRestoring: true, availability: current });
      }
      if (current.state === "absent") {
        return clientErr("This node does not hold these bytes; there is nothing to restore", 409);
      }

      const tier = body.tier === "Bulk" ? "Bulk" : "Standard";
      const estimate = estimateRestore(
        record.sizeBytes,
        1,
        tier,
        RESTORED_COPY_RETENTION_DAYS,
      );
      if (body.confirm !== true) {
        return ok({ estimate, availability: current, confirmRequired: true });
      }

      // Rate limit *before* issuing, and per app. A restore is the one endpoint
      // here where a loop costs real money rather than CPU, and the app most
      // likely to loop is one retrying on a failure it doesn't understand.
      const limited = await checkRestoreRateLimit(db, appId, record.sizeBytes);
      if (!limited.ok) return clientErr(limited.message, 429);

      // Actually ask S3 to thaw it. Recording `restoring` without issuing this
      // would produce an endpoint that reports progress on a restore nobody
      // started — which is worse than not having the endpoint, because it looks
      // like it worked and the object never becomes readable.
      const outcome = await storage.restoreObject(record.objectStorageKey, {
        tier,
        days: RESTORED_COPY_RETENTION_DAYS,
      });

      const readyAtMs = Date.now() + estimate.estimatedHours * 60 * 60 * 1000;
      await db.putAvailability({
        objectStorageKey: record.objectStorageKey,
        state: "restoring",
        tier: current.tier,
        expectedLatencyHours: estimate.estimatedHours,
        readyAtMs,
        restoredUntilMs: null,
        observedAtMs: Date.now(),
      });

      return ok({
        restoring: true,
        // Distinguished so a caller can tell "I started this" from "someone
        // else already had". Both are successes; only one is billable.
        alreadyInProgress: outcome === "already-in-progress",
        estimate,
        availability: {
          state: "restoring",
          readyAt: new Date(readyAtMs).toISOString(),
        } satisfies RecordAvailability,
      });
    }

    const fileUrlMatch = subPath.match(/^\/data\/records\/([^/]+)\/file-url$/);
    if (fileUrlMatch && method === "GET") {
      const id = decodeURIComponent(fileUrlMatch[1]!) as StarkeepId;
      const record = await db.get(id);
      if (!record || record.deletedAt) return clientErr("Record not found", 404);
      if (!canRead(grants, record.type)) return clientErr("Forbidden", 403);
      if (!record.objectStorageKey) return clientErr("Record has no attached file", 404);
      // Refuse rather than hand out a URL that will fail — or worse, one whose
      // use would trigger a thaw. A read never restores implicitly.
      const readAvailability = toRecordAvailability(
        (await db.getAvailability([record.objectStorageKey])).get(record.objectStorageKey),
      );
      const refusal = archivedReadRefusal(readAvailability);
      if (refusal) return { statusCode: refusal.status, body: JSON.stringify(refusal.body) };
      const expiresIn = parseInt(query["expiresIn"] ?? "3600", 10);
      const key = record.objectStorageKey;
      // Shared bytes → CloudFront signed URL (through the chokepoint); any
      // non-shared key stays on S3 presign.
      if (key.startsWith("shared/")) {
        const signed = await signSharedCloudFrontUrl(appId, key, grants, expiresIn);
        if (!signed.ok) return clientErr(signed.message, signed.status);
        return ok({ url: signed.url, source: "remote", mimeType: record.mimeType, sizeBytes: record.sizeBytes, expiresIn });
      }
      const url = await storage.getSignedUrl!(key, { expiresIn });
      return ok({ url, source: "remote", mimeType: record.mimeType, sizeBytes: record.sizeBytes, expiresIn });
    }

    // GET|PUT|DELETE /apps/{appId}/data/records/:id
    const recordIdMatch = subPath.match(/^\/data\/records\/([^/]+)$/);
    if (recordIdMatch) {
      const id = decodeURIComponent(recordIdMatch[1]!) as StarkeepId;

      if (method === "GET") {
        const record = await db.get(id);
        if (!record || record.deletedAt) return clientErr("Record not found", 404);
        if (!canRead(grants, record.type)) return clientErr("Forbidden", 403);
        // Same `include` vocabulary as the list route. Asking about one record
        // is the cheapest possible form of "is this record a rendition", and
        // without it the only way to answer that was to list the library and
        // look — which is O(library) to learn one bit.
        const detailInclude = (query["include"] ?? "").split(",").map((s) => s.trim());
        const detailLabels = detailInclude.includes("labels")
          ? await loadLabelsForPage(db, [record], query["labelApps"])
          : null;
        const detailMeta = detailInclude.includes("metadata")
          ? await loadMetadataForPage(db, grants, [record])
          : null;
        const detailAvailability = await loadAvailabilityForPage(db, [record]);
        return ok({
          record: recordToResponse(
            record,
            detailMeta ? detailMeta.get(record.id) ?? null : undefined,
            detailLabels ? detailLabels.get(record.id) ?? [] : undefined,
            undefined,
            detailAvailability.get(record.id) ?? DEFAULT_AVAILABILITY,
          ),
        });
      }

      if (method === "PUT") {
        // Records are immutable apart from system mutations (promotion, sync,
        // tombstones). Editing user fields lives in app-specific data which is
        // out of scope; the PUT endpoint accepts only originalFilename and
        // parentId for now.
        const body = event.body
          ? (JSON.parse(event.body) as { originalFilename?: string | null; parentId?: string | null })
          : null;
        if (!body) return clientErr("body is required", 400);
        // Read-modify-write: `version` is derived from the row we read, so the
        // whole get→compute→put must be one OCC unit. Retrying only the put
        // would replay a stale version and lose a concurrent update; wrapping
        // here re-reads `existing` on conflict so version advances correctly.
        // `await` (not a bare return) so the handler's finally — which closes
        // the DB — runs only after the retry unit settles.
        return await withOccRetry("PUT /data/records/:id", async () => {
          const existing = await db.get(id);
          if (!existing || existing.deletedAt) return clientErr("Record not found", 404);
          if (!canWrite(grants, existing.type)) return clientErr("Forbidden", 403);
          const now = clock.now();
          const updated: DataRecord = {
            ...existing,
            originalFilename: body.originalFilename ?? existing.originalFilename,
            parentId: (body.parentId as DataRecord["parentId"]) ?? existing.parentId,
            updatedAt: now,
            version: existing.version + 1,
          };
          await db.put(updated);
          return ok({ record: recordToResponse(updated) });
        });
      }

      if (method === "DELETE") {
        // get (existence + auth) → delete is one OCC unit; retry re-reads.
        // `await` so the handler's finally (DB close) runs after it settles.
        return await withOccRetry("DELETE /data/records/:id", async () => {
          const existing = await db.get(id);
          if (!existing || existing.deletedAt) return clientErr("Record not found", 404);
          if (!canWrite(grants, existing.type)) return clientErr("Forbidden", 403);
          const hlc = clock.now();
          await db.delete(id, hlc);
          // Cascade to labels by hand: DSQL has no foreign keys, so nothing
          // does this for us. Crosses app namespaces on purpose — the record
          // is going away, so every app's assertions about it go with it.
          // This is a platform operation riding on the record delete, not an
          // app write, which is why it isn't gated on the caller owning those
          // labels.
          await db.tombstoneLabelsForRecord(id, hlc);
          return ok({ deleted: true });
        });
      }
    }

    // ---- App-specific syncable data (mirrors local-data-server) ----
    // All /app-data/... routes are scoped to the caller's appId (resolved
    // from the path prefix above). The factory's view refuses ops on tables/
    // files the app didn't declare; absence of the namespace means the app
    // didn't declare appSpecificSyncable in its manifest.
    if (subPath.startsWith("/app-data/")) {
      const view = await getAppSpecificView();
      if (!view) {
        return clientErr("App did not declare appSpecificSyncable in its manifest", 404);
      }

      const dbMatch = subPath.match(/^\/app-data\/db\/([^/]+)$/);
      if (dbMatch) {
        const table = decodeURIComponent(dbMatch[1]!);
        try {
          if (method === "POST") {
            const raw = event.isBase64Encoded && event.body
              ? Buffer.from(event.body, "base64").toString("utf8")
              : (event.body ?? "{}");
            const body = JSON.parse(raw) as { row?: Record<string, unknown> };
            if (!body.row) return clientErr("row is required", 400);
            await view.insertRow(table, body.row);
            return ok({ ok: true });
          }
          if (method === "PATCH") {
            const raw = event.isBase64Encoded && event.body
              ? Buffer.from(event.body, "base64").toString("utf8")
              : (event.body ?? "{}");
            const body = JSON.parse(raw) as {
              where?: Record<string, unknown>;
              patch?: Record<string, unknown>;
            };
            if (!body.where || !body.patch) {
              return clientErr("where and patch are required", 400);
            }
            const changes = await view.updateRow(table, body.where, body.patch);
            return ok({ changes });
          }
          if (method === "DELETE") {
            const raw = event.isBase64Encoded && event.body
              ? Buffer.from(event.body, "base64").toString("utf8")
              : (event.body ?? "{}");
            const body = JSON.parse(raw) as { where?: Record<string, unknown> };
            if (!body.where) return clientErr("where is required", 400);
            const changes = await view.deleteRow(table, body.where);
            return ok({ changes });
          }
          if (method === "GET") {
            const where: Record<string, unknown> = { ...query };
            const rows = await view.queryRows(table, Object.keys(where).length ? where : undefined);
            return ok({ rows });
          }
        } catch (err) {
          return clientErr(err instanceof Error ? err.message : String(err), 400);
        }
        return clientErr("Method not allowed", 405);
      }

      // POST /app-data/files/presign — issue a presigned S3 PUT URL for an
      // app-private file. Body: { subKey, contentType? }. The client uploads
      // bytes directly to S3 (bypassing the APIGW body cap), then calls the
      // /record route below to write the index row. The key is constructed
      // server-side from appId + subKey so the client never sees the scheme.
      if (subPath === "/app-data/files/presign" && method === "POST") {
        try {
          const raw = event.isBase64Encoded && event.body
            ? Buffer.from(event.body, "base64").toString("utf8")
            : (event.body ?? "{}");
          const body = JSON.parse(raw) as { subKey?: string; contentType?: string };
          if (!body.subKey) return clientErr("subKey is required", 400);
          // statFile enforces filesEnabled + the per-app key prefix; we only
          // use it here to surface a clear manifest error before signing.
          await view.statFile(body.subKey);
          const key = appSyncableObjectKey(appId, body.subKey);
          const url = await storage.getSignedPutUrl!(key, {
            expiresIn: clampPresignExpiresIn(3600),
            ...(body.contentType ? { contentType: body.contentType } : {}),
          });
          return ok({ url, key });
        } catch (err) {
          return clientErr(err instanceof Error ? err.message : String(err), 400);
        }
      }

      // POST /app-data/files/<subKey>/record — register a file uploaded
      // out-of-band via the presign flow. Body:
      // { contentHash, mimeType, sizeBytes, originalFilename? }. Writes the
      // index row so the file becomes visible to statFile and cross-channel
      // sync without the broker ever holding the bytes.
      const fileRecordMatch = subPath.match(/^\/app-data\/files\/(.+)\/record$/);
      if (fileRecordMatch && method === "POST") {
        const subKey = decodeURIComponent(fileRecordMatch[1]!);
        try {
          const raw = event.isBase64Encoded && event.body
            ? Buffer.from(event.body, "base64").toString("utf8")
            : (event.body ?? "{}");
          const body = JSON.parse(raw) as {
            contentHash?: string;
            mimeType?: string;
            sizeBytes?: number;
            originalFilename?: string | null;
          };
          if (!body.contentHash || !body.mimeType || typeof body.sizeBytes !== "number") {
            return clientErr("contentHash, mimeType, and sizeBytes are required", 400);
          }
          const result = await view.registerFile(subKey, {
            contentHash: body.contentHash,
            mimeType: body.mimeType,
            sizeBytes: body.sizeBytes,
            originalFilename: body.originalFilename ?? null,
          });
          return ok(result);
        } catch (err) {
          return clientErr(err instanceof Error ? err.message : String(err), 400);
        }
      }

      const fileMatch = subPath.match(/^\/app-data\/files\/(.+)$/);
      if (fileMatch) {
        const subKey = decodeURIComponent(fileMatch[1]!);
        try {
          // Writes go through the presign + /record flow above — there is no
          // body-through PUT on the app-data file plane (the broker never holds
          // app-private bytes).
          if (method === "GET") {
            // Manifest gate + key construction live in the factory; we use
            // statFile (which enforces filesEnabled and the per-app key prefix)
            // to verify existence from the index row — no byte download — then
            // presign directly because the factory's fileUrl is sync and S3
            // presigning is async.
            const stat = await view.statFile(subKey);
            if (!stat) return clientErr("File not found", 404);
            const requested = parseInt(query["expiresIn"] ?? "3600", 10);
            const expiresIn = clampPresignExpiresIn(
              Number.isFinite(requested) ? requested : 3600,
            );
            const objectKey = appSyncableObjectKey(appId, subKey);
            const url = await storage.getSignedUrl(objectKey, { expiresIn });
            return ok({ url, expiresIn });
          }
          if (method === "DELETE") {
            await view.deleteFile(subKey);
            return ok({ ok: true });
          }
        } catch (err) {
          return clientErr(err instanceof Error ? err.message : String(err), 400);
        }
        return clientErr("Method not allowed", 405);
      }

      return clientErr("Not found", 404);
    }

    // POST /apps/{appId}/sync/exchange — version-vector exchange.
    // Body: SyncExchangeRequest. Writes go under the calling channel's
    // identity; PG GRANTs gate which types this channel can write. No
    // originAppId-grouping (deprecated under the exchange protocol).
    if (method === "POST" && subPath === "/sync/exchange") {
      const rawBody = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64").toString("utf8")
        : (event.body ?? "{}");
      // Signed, but not therefore well-formed. The budgets in this body reach
      // a `LIMIT ?` and the digest width reaches `substr(updated_at, 1, N)`,
      // so a peer on an older build or a field that drifted type used to come
      // back as a 500 out of the query layer. Clamped where the caller is
      // asking for too much, refused where it cannot be read at all.
      let body;
      try {
        body = sanitizeExchangeRequest(JSON.parse(rawBody));
      } catch (err) {
        if (err instanceof InvalidExchangeRequest) return clientErr(err.message, 400);
        if (err instanceof SyntaxError) return clientErr("Body is not valid JSON", 400);
        throw err;
      }

      // Channel split. The Starkeep Drive channel carries *all* shared
      // records (and nothing app-specific); every per-app channel carries only
      // that app's app-specific rows (and no shared records). This makes
      // shared-record sync identical regardless of which apps are cloud-
      // installed: the Drive channel always exists, so shared data always has
      // an authorized cloud writer.
      const isDriveChannel = appId === DRIVE_APP_ID;
      let transport;
      if (isDriveChannel) {
        transport = createInProcessSyncTransport({
          databaseAdapter: db,
          clock,
          objectStorage: storage,
          syncSharedRecords: true,
        });
      } else {
        const source = await getAppSyncableSource();
        // Scope the namespace store to the calling channel's app. The loaded
        // store spans every installed app; without this filter the exchange
        // scan — and worse, the coverage watermark — would cover foreign
        // apps' tables, and a readable foreign row with a higher HLC on the
        // same nodeId would mask this channel's own unshipped rows. PG
        // grants usually deny cross-app reads, but scoping must not depend
        // on permission failures.
        const scopedNamespaces = {
          get: (id: string) => (id === appId ? source.namespaces.get(id) : null),
          list: () =>
            source.namespaces.list().filter((ns) => ns.appId === appId),
        };
        transport = createInProcessSyncTransport({
          databaseAdapter: db,
          clock,
          appSyncableSource: {
            namespaces: scopedNamespaces,
            applier: source.applier,
          },
          objectStorage: storage,
          syncSharedRecords: false,
        });
      }
      const response = await transport.exchange(body);
      return ok(response);
    }

    return clientErr("Not found", 404);
  } catch (e) {
    // S3 AccessDenied surfaces when an app touches a key its per-app IAM role
    // can't reach — typically a write to shared/<typeId>/* for a type the
    // manifest only granted read access to. Map to 403 so callers can
    // distinguish a permission problem from an unexpected server fault.
    if (isAccessDenied(e)) {
      console.warn("Handler access denied:", (e as Error).message);
      return clientErr("AccessDenied", 403);
    }
    console.error("Handler error:", e);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal server error" }),
    };
  } finally {
    // Close every pg client we opened. Without this, sockets outlive the
    // handler, DSQL eventually closes them, and the resulting async 'error'
    // event arrives on a future invocation. Errors during close are
    // intentionally swallowed — at this point the handler has already
    // returned a response, and a failed .end() should not corrupt that.
    await Promise.allSettled(toClose.map((close) => close()));
  }
}

async function buildAppSyncableSource(
  clientFactory: DatabaseClientFactory,
  hostname: string,
  region: string,
): Promise<{
  namespaces: DsqlAppSyncableNamespaceStore;
  applier: DsqlAppSyncableApplier;
  client: DatabaseClient;
}> {
  const client = await clientFactory.createClient({ hostname, region });
  const namespaces = new DsqlAppSyncableNamespaceStore(client);
  await namespaces.load();
  const applier = new DsqlAppSyncableApplier(client, namespaces);
  return { namespaces, applier, client };
}

function isAccessDenied(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name;
  if (name === "AccessDenied" || name === "Forbidden") return true;
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return status === 403;
}
