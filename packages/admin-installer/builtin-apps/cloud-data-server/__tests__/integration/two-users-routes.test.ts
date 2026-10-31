/**
 * Two users through the broker's own routes, against one real Postgres.
 *
 * The plan's two-user route test: user A writes, and user B reads, lists,
 * counts, labels, signs, syncs and deletes through the same routes and gets
 * none of A's library. Every query here runs as SQL against PGlite, so this
 * checks the cut end to end: the gate names the user, the adapters compile
 * through the user-scoped compiler, and the tripwire refuses any statement
 * that went around it. The adapter-level version, over every adapter and
 * applier operation, is `storage-aurora-dsql/__tests__/two-users.test.ts`.
 *
 * Not every route has a case. The broker's router is a chain of conditions
 * rather than a table, so the routes cannot be enumerated from it; the cases
 * cover each kind of access — read by id, list, count, label, sign, sync,
 * delete — and the tripwire covers every statement any route issues.
 *
 * See `~/projects/starkeep/plan-multi-user-roles-2026-10-16.md`, phase 4
 * "Checks".
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PGlite } from "@electric-sql/pglite";
import { signRequest } from "@starkeep/app-client";
import type { APIGatewayEvent, LambdaContext } from "../../src/handler-utils.js";
import { installUserTokenFixture, mintTestUserToken } from "../user-token.js";
import {
  createAppNodeWatermarks,
  createSharedSchema,
} from "../../../../../storage-aurora-dsql/__tests__/pg-shared-schema.js";
import { createHash, sign } from "node:crypto";
import { PutParameterCommand, ParameterAlreadyExists } from "@aws-sdk/client-ssm";
import {
  mobileSignedMessage,
  pgColumnType,
  serializeHLC,
  type HLCTimestamp,
} from "@starkeep/protocol-primitives";
import {
  FILE_RECORDS_COLUMNS,
  FILE_RECORDS_TABLE,
  FILE_RECORDS_TABLE_INFO,
} from "@starkeep/shared-space-api";
import { resetMobileKeyCaches } from "../../src/mobile-keys.js";
import {
  TEST_CERT_DIGEST,
  TEST_PACKAGE,
  testAuthority,
  type KeyPair,
} from "../attestation-chain.js";

const ssmMock = mockClient(SSMClient);
const stsMock = mockClient(STSClient);
const s3Mock = mockClient(S3Client);

const context: LambdaContext = {
  invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:teststack-cds",
};
const CF_SIGNING_PARAM = "/teststack/app-creds/_cloudfront-signing";
const cfKeyPair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

const DRIVE = "starkeep-drive";
const A = "user-a";
const B = "user-b";
const HASH = "c".repeat(64);

type HandlerModule = typeof import("../../src/api-handler.js");
let handler: HandlerModule["handler"];
let setDbFactory: HandlerModule["__setDatabaseClientFactoryForTests"];
let setAttestation: HandlerModule["__setAttestationForTests"];
/** Each user's token from the mobile-apps client, as Photos Mobile holds it. */
const mobileTokens: Record<string, string> = {};
const MOBILE_CLIENT_ID = "test-mobile-client";
const authority = testAuthority();
/** SSM parameters the broker wrote: the mobile keys. */
let ssmWrites: Map<string, string>;
const tokens: Record<string, string> = {};
/** Each user's token from the device client, as a signed-in desktop or phone holds it. */
const deviceTokens: Record<string, string> = {};
const DEVICE_CLIENT_ID = "test-device-client";
let pg: PGlite;

beforeAll(async () => {
  process.env.STACK_PREFIX = "teststack";
  process.env.AURORA_ENDPOINT = "pglite.test";
  process.env.S3_BUCKET = "fake-bucket";
  process.env.AWS_REGION = "us-east-1";
  process.env.CLOUDFRONT_SIGNING_PARAM = CF_SIGNING_PARAM;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  const mod = await import("../../src/api-handler.js");
  handler = mod.handler;
  setDbFactory = mod.__setDatabaseClientFactoryForTests;
  setAttestation = mod.__setAttestationForTests;
  setAttestation([authority.rootPem], new Set());
  await installUserTokenFixture();
  tokens[A] = await mintTestUserToken({ sub: A });
  tokens[B] = await mintTestUserToken({ sub: B });
  process.env.STARKEEP_DEVICE_USER_POOL_CLIENT_ID = DEVICE_CLIENT_ID;
  process.env.STARKEEP_MOBILE_USER_POOL_CLIENT_ID = MOBILE_CLIENT_ID;
  for (const user of [A, B]) {
    deviceTokens[user] = await mintTestUserToken({ sub: user, aud: DEVICE_CLIENT_ID });
    mobileTokens[user] = await mintTestUserToken({ sub: user, aud: MOBILE_CLIENT_ID });
  }
});

afterAll(() => {
  setDbFactory(null);
});

beforeEach(async () => {
  pg = new PGlite();
  await pg.waitReady;
  await createSharedSchema(pg);
  await pg.exec(`
    INSERT INTO shared.app_label_keys (app_id, key, description) VALUES ('${DRIVE}', 'faces', null);
    CREATE SCHEMA app_starkeep_drive;
    CREATE TABLE app_starkeep_drive._starkeep_byte_coverage (
      user_id text NOT NULL,
      node_id text NOT NULL,
      hlc text NOT NULL,
      PRIMARY KEY (user_id, node_id)
    );
  `);
  await createAppNodeWatermarks(pg, "app_starkeep_drive");
  setDbFactory({
    createClient: async () => ({
      async query(text, values) {
        const result = await pg.query(text, values as unknown[] | undefined);
        return { rows: result.rows as Record<string, unknown>[] };
      },
      async end() {},
    }),
  });

  ssmMock.reset();
  stsMock.reset();
  s3Mock.reset();
  resetMobileKeyCaches();
  ssmWrites = new Map();
  ssmMock.on(PutParameterCommand).callsFake(async (input: { Name: string; Value: string }) => {
    if (ssmWrites.has(input.Name)) {
      throw new ParameterAlreadyExists({ message: "exists", $metadata: {} });
    }
    ssmWrites.set(input.Name, input.Value);
    return {};
  });
  ssmMock.on(GetParameterCommand).callsFake(async (input: { Name?: string }) => {
    const written = ssmWrites.get(input.Name!);
    if (written !== undefined) return { Parameter: { Value: written } };
    if (input.Name === CF_SIGNING_PARAM) {
      return {
        Parameter: {
          Value: JSON.stringify({
            keyPairId: "KTEST",
            domain: "dtest.cloudfront.net",
            privateKey: cfKeyPair.privateKey,
          }),
        },
      };
    }
    const appId = input.Name!.split("/").pop()!;
    return { Parameter: { Value: JSON.stringify({ hmacSecret: `secret-${appId}` }) } };
  });
  stsMock.on(AssumeRoleCommand).resolves({
    Credentials: {
      AccessKeyId: "AKIAFAKE",
      SecretAccessKey: "fake-secret",
      SessionToken: "fake-token",
      Expiration: new Date(Date.now() + 900_000),
    },
  });
  s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 3 });
});

afterEach(async () => {
  await pg.close();
});

function as(
  userId: string,
  method: string,
  subPath: string,
  body?: unknown,
  appId: string = DRIVE,
): APIGatewayEvent {
  const bodyless = method === "GET" || method === "HEAD" || method === "DELETE";
  const bodyStr = body === undefined ? undefined : JSON.stringify(body);
  const headers = signRequest({
    appId,
    hmacSecret: `secret-${appId}`,
    method,
    path: subPath,
    ...(bodyless ? {} : { body: bodyStr }),
  });
  return {
    rawPath: `/apps/${appId}${subPath}`,
    requestContext: { http: { method } },
    headers: { ...headers, "X-Starkeep-User-Token": tokens[userId]! },
    ...(bodyStr !== undefined ? { body: bodyStr } : {}),
  };
}

/** The same call from a signed-in device: the device token alone, no app signature. */
async function callAsDevice(userId: string, method: string, subPath: string, body?: unknown) {
  const bodyStr = body === undefined ? undefined : JSON.stringify(body);
  const res = await handler(
    {
      rawPath: `/apps/${DRIVE}${subPath}`,
      requestContext: { http: { method } },
      headers: { "X-Starkeep-User-Token": deviceTokens[userId]! },
      ...(bodyStr !== undefined ? { body: bodyStr } : {}),
    },
    context,
  );
  return {
    status: res.statusCode,
    body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {},
  };
}

async function call(
  userId: string,
  method: string,
  subPath: string,
  body?: unknown,
  appId: string = DRIVE,
) {
  const res = await handler(as(userId, method, subPath, body, appId), context);
  return {
    status: res.statusCode,
    body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {},
  };
}

/** A's photo, registered by hash: the bytes are "already uploaded". */
async function aWritesAPhoto(): Promise<string> {
  const res = await call(A, "POST", "/data/records", {
    type: "image/jpeg",
    contentType: "image/jpeg",
    contentHash: HASH,
    sizeBytes: 3,
    fileName: "cat.jpg",
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const record = res.body["record"] as { id: string; object_storage_key: string };
  expect(record.object_storage_key).toBe(`shared/${A}/image/cc/${HASH}`);
  return record.id;
}

describe("two users through the broker", () => {
  it("B reads, lists and counts none of A's records", async () => {
    const id = await aWritesAPhoto();

    expect((await call(A, "GET", `/data/records/${id}`)).status).toBe(200);
    expect((await call(B, "GET", `/data/records/${id}`)).status).toBe(404);
    expect((await call(B, "GET", "/data/records")).body["records"]).toEqual([]);
    expect((await call(B, "GET", "/data/types")).body["total"]).toBe(0);
    expect((await call(A, "GET", "/data/types")).body["total"]).toBe(1);
  });

  it("B can neither label nor sign A's record", async () => {
    const id = await aWritesAPhoto();

    const label = await call(B, "POST", "/data/labels", {
      labels: [{ recordId: id, key: "faces", value: "Eve" }],
    });
    expect(label.status).not.toBe(200);
    const { rows } = await pg.query("SELECT * FROM shared.record_labels");
    expect(rows).toEqual([]);

    const urls = await call(B, "POST", "/data/records/file-urls", { ids: [id] });
    expect(JSON.stringify(urls.body)).not.toContain(HASH);
  });

  it("B's sync exchange carries none of A's records", async () => {
    const id = await aWritesAPhoto();

    const forB = await call(B, "POST", "/sync/exchange", { watermarks: {} });
    expect(forB.status, JSON.stringify(forB.body)).toBe(200);
    expect(forB.body["records"]).toEqual([]);
    const forA = await call(A, "POST", "/sync/exchange", { watermarks: {} });
    expect((forA.body["records"] as Array<{ id: string }>).map((r) => r.id)).toEqual([id]);
  });

  it("B's signed-in device syncs none of A's records, and A's syncs A's", async () => {
    const id = await aWritesAPhoto();

    const forB = await callAsDevice(B, "POST", "/sync/exchange", { watermarks: {} });
    expect(forB.status, JSON.stringify(forB.body)).toBe(200);
    expect(forB.body["records"]).toEqual([]);
    const forA = await callAsDevice(A, "POST", "/sync/exchange", { watermarks: {} });
    expect((forA.body["records"] as Array<{ id: string }>).map((r) => r.id)).toEqual([id]);
  });

  it("B's signed-in device reads none of A's records through the read-only routes", async () => {
    await aWritesAPhoto();

    expect((await callAsDevice(B, "GET", "/data/records")).body["records"]).toEqual([]);
    expect((await callAsDevice(A, "GET", "/data/types")).body["total"]).toBe(1);
  });

  it("B's signed-in device can neither presign, stat nor HEAD A's file", async () => {
    await aWritesAPhoto();
    const aKey = `shared/${A}/image/cc/${HASH}`;

    expect((await callAsDevice(B, "POST", "/files/presign", { key: aKey })).status).toBe(403);
    expect((await callAsDevice(B, "GET", `/files/${aKey}/presign`)).status).toBe(403);
    expect((await callAsDevice(B, "GET", `/files/${aKey}/stat`)).status).toBe(403);
    expect((await callAsDevice(B, "HEAD", `/files/${aKey}`)).status).toBe(403);

    // A's own device reaches the same file, so the refusals above are about
    // the user, not the route.
    expect((await callAsDevice(A, "GET", `/files/${aKey}/stat`)).status).toBe(200);
    expect((await callAsDevice(A, "HEAD", `/files/${aKey}`)).status).toBe(200);
  });

  it("B cannot delete A's record", async () => {
    const id = await aWritesAPhoto();

    expect((await call(B, "DELETE", `/data/records/${id}`)).status).toBe(404);
    // The get route answers 404 for a deleted record, so A's 200 is the proof.
    expect((await call(A, "GET", `/data/records/${id}`)).status).toBe(200);
  });

  it("tags each app session with the user it acts for, one session per user", async () => {
    // Users no earlier case has used, so the warm credential cache holds no
    // session for them.
    tokens["user-c"] = await mintTestUserToken({ sub: "user-c" });
    tokens["user-d"] = await mintTestUserToken({ sub: "user-d" });
    await call("user-c", "GET", "/data/records");
    await call("user-d", "GET", "/data/records");
    await call("user-c", "GET", "/data/records");
    const tags = stsMock
      .commandCalls(AssumeRoleCommand)
      .map((c) => c.args[0].input)
      .filter((input) => input.RoleArn!.endsWith(`-app-${DRIVE}-role`))
      .map((input) => input.Tags);
    // C's second request reuses C's session.
    expect(tags).toEqual([
      [{ Key: "starkeep:userId", Value: "user-c" }],
      [{ Key: "starkeep:userId", Value: "user-d" }],
    ]);
  });

  it("the same photo is one record per user, each under its own key", async () => {
    const id = await aWritesAPhoto();
    const res = await call(B, "POST", "/data/records", {
      type: "image/jpeg",
      contentType: "image/jpeg",
      contentHash: HASH,
      sizeBytes: 3,
      fileName: "cat.jpg",
    });
    expect(res.status).toBe(201);
    const record = res.body["record"] as { id: string; object_storage_key: string };
    // Content-addressed: one file, one id, in each library.
    expect(record.id).toBe(id);
    expect(record.object_storage_key).toBe(`shared/${B}/image/cc/${HASH}`);
    const { rows } = await pg.query("SELECT user_id FROM shared.records ORDER BY user_id");
    expect(rows).toEqual([{ user_id: A }, { user_id: B }]);
  });
});

describe("a mobile app through the broker", () => {
  const PHOTOS = "photos";

  /** Photos' mobile build registered with no cloud compute: grants, keys, identity. */
  async function registerPhotosMobile(): Promise<void> {
    await pg.exec(`
      INSERT INTO shared.access_grants (app_id, type_id, access) VALUES ('${PHOTOS}', 'image/jpeg', 'readwrite');
      INSERT INTO shared.app_label_keys (app_id, key, description) VALUES ('${PHOTOS}', 'album', null);
      INSERT INTO shared.app_mobile_identities (app_id, android_package, android_cert_digests, callback_scheme)
        VALUES ('${PHOTOS}', '${TEST_PACKAGE}', '${JSON.stringify([TEST_CERT_DIGEST])}', 'starkeep-photos');
    `);
  }

  /** Register a key for `userId`'s phone, and return a signer for it. */
  async function phoneOf(userId: string) {
    const token = mobileTokens[userId]!;
    const challenge = createHash("sha256").update(token).digest();
    const { chain, key } = authority.chain({ challenge });
    const res = await handler(
      {
        rawPath: `/apps/${DRIVE}/mobile/keys`,
        requestContext: { http: { method: "POST" } },
        headers: { "X-Starkeep-User-Token": token },
        body: JSON.stringify({ chain: chain.map((c) => c.toString("base64")) }),
      },
      context,
    );
    expect(res.statusCode, res.body).toBe(200);
    const keyId = (JSON.parse(res.body) as { keyId: string }).keyId;
    return {
      async call(method: string, subPath: string, body?: unknown, appId: string = DRIVE) {
        const bodyStr = body === undefined ? "" : JSON.stringify(body);
        const ts = Date.now();
        const message = mobileSignedMessage(appId, method, subPath, ts, Buffer.from(bodyStr));
        const out = await handler(
          {
            rawPath: `/apps/${appId}${subPath}`,
            requestContext: { http: { method } },
            headers: {
              "X-Starkeep-User-Token": token,
              "X-Starkeep-Key-Id": keyId,
              "X-Starkeep-Key-Sig": sign("sha256", message, (key as KeyPair).privateKey).toString(
                "base64",
              ),
              "X-Starkeep-App-Ts": String(ts),
            },
            ...(body === undefined ? {} : { body: bodyStr }),
          },
          context,
        );
        return {
          status: out.statusCode,
          body: out.body ? (JSON.parse(out.body) as Record<string, unknown>) : {},
        };
      },
    };
  }

  /** A's markdown note, registered by hash through Drive. */
  async function aWritesANote(): Promise<string> {
    const res = await call(A, "POST", "/data/records", {
      type: "document/markdown",
      contentType: "text/markdown",
      contentHash: "d".repeat(64),
      sizeBytes: 3,
      fileName: "note.md",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return (res.body["record"] as { id: string }).id;
  }

  it("syncs only the types the app's manifest grants, with no cloud compute for the app", async () => {
    await registerPhotosMobile();
    const photo = await aWritesAPhoto();
    await aWritesANote();

    const phone = await phoneOf(A);
    const pulled = await phone.call("POST", "/sync/exchange", { watermarks: {} });
    expect(pulled.status, JSON.stringify(pulled.body)).toBe(200);
    expect((pulled.body["records"] as Array<{ id: string }>).map((r) => r.id)).toEqual([photo]);

    // The desktop, on the same channel, still sees both.
    const desktop = await callAsDevice(A, "POST", "/sync/exchange", { watermarks: {} });
    expect((desktop.body["records"] as unknown[]).length).toBe(2);
  });

  it("refuses a label whose record type differs from its record's", async () => {
    await registerPhotosMobile();
    const photo = await aWritesAPhoto();
    const phone = await phoneOf(A);
    const pushLabel = (recordType: string) =>
      phone.call("POST", "/sync/exchange", {
        watermarks: {},
        labels: [
          {
            recordId: photo,
            appId: PHOTOS,
            key: "album",
            value: "x",
            recordType,
            createdAt: { wallTime: Date.now(), counter: 0, nodeId: "phone-a" },
            updatedAt: { wallTime: Date.now(), counter: 0, nodeId: "phone-a" },
            nodeId: "phone-a",
            deletedAt: null,
          },
        ],
      });

    // A phone's exchange narrows labels by their record type, so a forged one
    // would reach phones whose grants exclude the record.
    expect((await pushLabel("document/markdown")).status).toBe(403);
    expect((await pg.query("SELECT 1 FROM shared.record_labels")).rows).toEqual([]);
    const ok = await pushLabel("image/jpeg");
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("reports a digest over exactly the rows the phone holds, so the two agree", async () => {
    await registerPhotosMobile();
    await aWritesAPhoto();
    await aWritesANote();
    const phone = await phoneOf(A);

    const res = await phone.call("POST", "/sync/exchange", {
      watermarks: {},
      requestDigest: true,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const records = res.body["records"] as Array<{ updatedAt: HLCTimestamp }>;
    expect(records).toHaveLength(1);
    // What the phone's own digest counts: the rows it received, per author
    // and time bucket, over the serialized timestamp.
    const width = res.body["digestPrefixLength"] as number;
    const expected = new Map<string, number>();
    for (const r of records) {
      const key = `${r.updatedAt.nodeId}|${serializeHLC(r.updatedAt).slice(0, width)}`;
      expected.set(key, (expected.get(key) ?? 0) + 1);
    }
    const digest = res.body["digest"] as Array<{ nodeId: string; bucket: string; count: number }>;
    expect(new Map(digest.map((d) => [`${d.nodeId}|${d.bucket}`, d.count]))).toEqual(expected);
    // And the coverage watermark names the phone's rows alone.
    const watermarks = res.body["responderWatermarks"] as Record<string, HLCTimestamp>;
    expect(Object.values(watermarks).map(serializeHLC)).toEqual(
      records.map((r) => serializeHLC(r.updatedAt)),
    );
  });

  it("refuses a push carrying one record of a type the app may not write, whole", async () => {
    await registerPhotosMobile();
    const phone = await phoneOf(A);
    const res = await phone.call("POST", "/sync/exchange", {
      watermarks: {},
      records: [
        {
          id: "r-note",
          type: "document/markdown",
          createdAt: "2026-10-27T00:00:00.000Z",
          updatedAt: { wallTime: Date.now(), counter: 0, nodeId: "phone-1" },
          deletedAt: null,
          version: 1,
          contentHash: "d".repeat(64),
          objectStorageKey: `shared/${A}/document/dd/${"d".repeat(64)}`,
          sizeBytes: 3,
          originAppId: PHOTOS,
        },
      ],
    });
    expect(res.status).toBe(403);
    const { rows } = await pg.query("SELECT id FROM shared.records");
    expect(rows).toEqual([]);
  });

  it("presigns its own categories and refuses every other", async () => {
    await registerPhotosMobile();
    const phone = await phoneOf(A);
    const imageKey = `shared/${A}/image/cc/${HASH}`;
    const noteKey = `shared/${A}/document/dd/${"d".repeat(64)}`;
    expect((await phone.call("GET", `/files/${imageKey}/stat`)).status).not.toBe(403);
    expect((await phone.call("GET", `/files/${noteKey}/stat`)).status).toBe(403);
    expect((await phone.call("POST", "/files/presign", { key: noteKey })).status).toBe(403);
  });

  /**
   * Photos' private schema and its namespace row, as the install DDL leaves
   * them. Photos' manifest declares `files: true`, so its real namespace also
   * has the reserved file table; `filesEnabled: false` is the narrower shape.
   */
  async function createPhotosPrivateTables({ filesEnabled = false } = {}): Promise<void> {
    const columns = [
      { name: "record_id", type: "text", notNull: true, primaryKey: true },
      { name: "caption", type: "text", notNull: false, primaryKey: false },
      { name: "title", type: "text", notNull: false, primaryKey: false },
      { name: "date_taken_override", type: "text", notNull: false, primaryKey: false },
    ];
    // The install DDL appends the reserved table to the namespace's tables.
    const tables = [
      { name: "image_enriched", pkColumns: ["record_id"], columns },
      ...(filesEnabled ? [FILE_RECORDS_TABLE_INFO] : []),
    ];
    await pg.exec(`
      CREATE SCHEMA app_photos;
      CREATE TABLE app_photos.image_enriched (
        user_id text NOT NULL,
        record_id text NOT NULL,
        caption text,
        title text,
        date_taken_override text,
        updated_at text NOT NULL,
        node_id text NOT NULL,
        deleted_at text,
        PRIMARY KEY (user_id, record_id)
      );
      CREATE TABLE app_photos._starkeep_byte_coverage (
        user_id text NOT NULL,
        node_id text NOT NULL,
        hlc text NOT NULL,
        PRIMARY KEY (user_id, node_id)
      );
      INSERT INTO shared.app_syncable_namespaces (app_id, tables_json, files_enabled)
        VALUES ('${PHOTOS}', '${JSON.stringify(tables)}', ${filesEnabled});
    `);
    await createAppNodeWatermarks(pg, "app_photos");
    if (filesEnabled) {
      // Column for column what `dsql-ddl.ts` creates for the reserved table.
      const reserved = FILE_RECORDS_COLUMNS.map(
        (c) => `${c.name} ${pgColumnType(c.type)}${c.notNull || c.primaryKey ? " NOT NULL" : ""}`,
      );
      const pks = FILE_RECORDS_COLUMNS.filter((c) => c.primaryKey).map((c) => c.name);
      await pg.exec(`
        CREATE TABLE app_photos.${FILE_RECORDS_TABLE} (
          user_id text NOT NULL,
          ${reserved.join(",\n          ")},
          updated_at text NOT NULL,
          node_id text NOT NULL,
          deleted_at text,
          PRIMARY KEY (user_id, ${pks.join(", ")})
        );
      `);
    }
  }

  /** A caption row as the phone's engine ships it. */
  function captionRow(recordId: string, caption: string, nodeId: string) {
    const timestamp = { wallTime: Date.now(), counter: 0, nodeId };
    return {
      timestamp,
      appId: PHOTOS,
      table: "image_enriched",
      op: "insert" as const,
      row: {
        record_id: recordId,
        caption,
        title: null,
        date_taken_override: null,
        updated_at: serializeHLC(timestamp),
        deleted_at: null,
      },
    };
  }

  it("syncs its own app's private rows on the app's channel, for its own user only", async () => {
    await registerPhotosMobile();
    await createPhotosPrivateTables();
    const phoneA = await phoneOf(A);

    const pushed = await phoneA.call(
      "POST",
      "/sync/exchange",
      { watermarks: {}, appSyncableRows: [captionRow("r1", "A's cat", "phone-a")] },
      PHOTOS,
    );
    expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
    const { rows } = await pg.query<{ user_id: string; caption: string }>(
      "SELECT user_id, caption FROM app_photos.image_enriched",
    );
    expect(rows).toEqual([{ user_id: A, caption: "A's cat" }]);

    // A second phone of A's pulls the row; B's phone pulls nothing.
    const pulledA = await (
      await phoneOf(A)
    ).call("POST", "/sync/exchange", { watermarks: {} }, PHOTOS);
    expect(pulledA.status, JSON.stringify(pulledA.body)).toBe(200);
    const rowsA = pulledA.body["appSyncableRows"] as Array<{ row: { caption: string } }>;
    expect(rowsA.map((r) => r.row.caption)).toEqual(["A's cat"]);
    expect(pulledA.body["records"]).toEqual([]);

    const pulledB = await (
      await phoneOf(B)
    ).call("POST", "/sync/exchange", { watermarks: {} }, PHOTOS);
    expect(pulledB.status, JSON.stringify(pulledB.body)).toBe(200);
    expect(pulledB.body["appSyncableRows"]).toEqual([]);
  });

  it("refuses shared records and labels on the app's own channel, whole", async () => {
    await registerPhotosMobile();
    await createPhotosPrivateTables();
    const phone = await phoneOf(A);
    const res = await phone.call(
      "POST",
      "/sync/exchange",
      {
        watermarks: {},
        appSyncableRows: [captionRow("r1", "smuggled", "phone-a")],
        labels: [
          {
            recordId: "r1",
            appId: PHOTOS,
            key: "album",
            value: "x",
            updatedAt: { wallTime: Date.now(), counter: 0, nodeId: "phone-a" },
            deletedAt: null,
          },
        ],
      },
      PHOTOS,
    );
    expect(res.status).toBe(403);
    expect((await pg.query("SELECT 1 FROM app_photos.image_enriched")).rows).toEqual([]);
  });

  /** A file row in Photos' reserved table, as the desktop's engine ships it. */
  function fileRow(userId: string, name: string, nodeId: string) {
    const timestamp = { wallTime: Date.now(), counter: 0, nodeId };
    const key = `apps/${PHOTOS}/${userId}/syncable/covers/${name}`;
    return {
      timestamp,
      appId: PHOTOS,
      table: FILE_RECORDS_TABLE,
      op: "insert" as const,
      row: {
        id: key,
        object_storage_key: key,
        content_hash: "e".repeat(64),
        mime_type: "image/jpeg",
        size_bytes: 3,
        original_filename: name,
        origin_app_id: PHOTOS,
        created_at: "2026-10-27T00:00:00.000Z",
        updated_at: serializeHLC(timestamp),
        deleted_at: null,
      },
    };
  }

  it("syncs captions on Photos' real namespace, files and all", async () => {
    await registerPhotosMobile();
    await createPhotosPrivateTables({ filesEnabled: true });

    // A's desktop, on the Photos channel, ships a cover image and a caption.
    const desktop = await call(
      A,
      "POST",
      "/sync/exchange",
      {
        watermarks: {},
        appSyncableRows: [
          fileRow(A, "cover.jpg", "desk-a"),
          captionRow("r1", "from desk", "desk-a"),
        ],
      },
      PHOTOS,
    );
    expect(desktop.status, JSON.stringify(desktop.body)).toBe(200);
    // A row that does not apply halts its author and still answers 200.
    expect(desktop.body["haltedAuthors"]).toBeUndefined();

    // A's phone pushes its own caption, then a second phone pulls everything.
    const pushed = await (
      await phoneOf(A)
    ).call(
      "POST",
      "/sync/exchange",
      { watermarks: {}, appSyncableRows: [captionRow("r2", "from phone", "phone-a")] },
      PHOTOS,
    );
    expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
    expect(pushed.body["haltedAuthors"]).toBeUndefined();

    const pulled = await (
      await phoneOf(A)
    ).call("POST", "/sync/exchange", { watermarks: {} }, PHOTOS);
    expect(pulled.status, JSON.stringify(pulled.body)).toBe(200);
    const rows = pulled.body["appSyncableRows"] as Array<{
      table: string;
      row: Record<string, unknown>;
    }>;
    expect(
      rows
        .filter((r) => r.table === "image_enriched")
        .map((r) => r.row["caption"])
        .sort(),
    ).toEqual(["from desk", "from phone"]);
    expect(rows.filter((r) => r.table === FILE_RECORDS_TABLE).map((r) => r.row["id"])).toEqual([
      `apps/${PHOTOS}/${A}/syncable/covers/cover.jpg`,
    ]);
    // The walk over the channel's bytes watermark ran, in Photos' schema.
    expect(pulled.body["responderByteWatermarks"]).toBeDefined();

    // B's phone, on the same namespace, pulls none of it.
    const forB = await (
      await phoneOf(B)
    ).call("POST", "/sync/exchange", { watermarks: {} }, PHOTOS);
    expect(forB.status, JSON.stringify(forB.body)).toBe(200);
    expect(forB.body["appSyncableRows"]).toEqual([]);
  });

  it("refuses a file row naming another user's key on the app's channel", async () => {
    await registerPhotosMobile();
    await createPhotosPrivateTables({ filesEnabled: true });
    const res = await (
      await phoneOf(A)
    ).call(
      "POST",
      "/sync/exchange",
      { watermarks: {}, appSyncableRows: [fileRow(B, "theirs.jpg", "phone-a")] },
      PHOTOS,
    );
    expect(res.status).toBe(403);
    expect((await pg.query(`SELECT 1 FROM app_photos.${FILE_RECORDS_TABLE}`)).rows).toEqual([]);
  });

  it("refuses a labels-only push on the app's own channel", async () => {
    await registerPhotosMobile();
    await createPhotosPrivateTables();
    const res = await (
      await phoneOf(A)
    ).call(
      "POST",
      "/sync/exchange",
      {
        watermarks: {},
        labels: [
          {
            recordId: "r1",
            appId: PHOTOS,
            key: "album",
            value: "x",
            updatedAt: { wallTime: Date.now(), counter: 0, nodeId: "phone-a" },
            deletedAt: null,
          },
        ],
      },
      PHOTOS,
    );
    expect(res.status).toBe(403);
    expect((await pg.query("SELECT 1 FROM shared.record_labels")).rows).toEqual([]);
  });

  it("bounds the file and record routes on the app's channel by the app's grants", async () => {
    await registerPhotosMobile();
    await createPhotosPrivateTables({ filesEnabled: true });
    const photo = await aWritesAPhoto();
    await aWritesANote();
    const phone = await phoneOf(A);
    const on = (method: string, subPath: string, body?: unknown) =>
      phone.call(method, subPath, body, PHOTOS);
    const imageKey = `shared/${A}/image/cc/${HASH}`;
    const noteKey = `shared/${A}/document/dd/${"d".repeat(64)}`;

    expect((await on("GET", `/files/${imageKey}/stat`)).status).not.toBe(403);
    expect((await on("GET", `/files/${imageKey}/presign`)).status).not.toBe(403);
    expect((await on("GET", `/files/${noteKey}/stat`)).status).toBe(403);
    expect((await on("GET", `/files/${noteKey}/presign`)).status).toBe(403);
    expect((await on("POST", "/files/presign", { key: noteKey })).status).toBe(403);

    // The record list is the app's readable types, for its own user.
    const listed = await on("GET", "/data/records");
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect((listed.body["records"] as Array<{ id: string }>).map((r) => r.id)).toEqual([photo]);
    // And a record write is no route a mobile app may call.
    expect(
      (
        await on("POST", "/data/records", {
          type: "image/jpeg",
          contentType: "image/jpeg",
          contentHash: HASH,
          sizeBytes: 3,
          fileName: "cat.jpg",
        })
      ).status,
    ).toBe(403);
  });

  it("B's phone, with B's key, syncs none of A's photos", async () => {
    await registerPhotosMobile();
    await aWritesAPhoto();
    const phone = await phoneOf(B);
    const res = await phone.call("POST", "/sync/exchange", { watermarks: {} });
    expect(res.status).toBe(200);
    expect(res.body["records"]).toEqual([]);
  });
});

/**
 * The `starkeep/no-cloud` refusal over real SQL. The broker lists the marked
 * records from the labels side and reads their keys by id, so these cases
 * check what that read must exclude.
 */
describe("the no-cloud refusal through the broker", () => {
  const hashOf = (c: string) => c.repeat(64);
  const keyOf = (c: string) => `shared/${A}/image/${c}${c}/${hashOf(c)}`;
  const LABEL_HLC = serializeHLC({ wallTime: Date.UTC(2026, 0, 1), counter: 0, nodeId: "n" });

  /** A's photo under the hash `c` repeated, registered through the route. */
  async function aRegisters(c: string): Promise<string> {
    const res = await call(A, "POST", "/data/records", {
      type: "image/jpeg",
      contentType: "image/jpeg",
      contentHash: hashOf(c),
      sizeBytes: 3,
      fileName: `${c}.jpg`,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return (res.body["record"] as { id: string }).id;
  }

  async function markNoCloud(recordId: string, options: { retracted?: boolean } = {}) {
    await pg.query(
      `INSERT INTO shared.record_labels
         (user_id, record_id, app_id, key, value, record_type, created_at, updated_at, node_id, deleted_at)
       VALUES ($1, $2, 'starkeep', 'no-cloud', '', 'image/jpeg', $3, $3, 'n', $4)`,
      [A, recordId, LABEL_HLC, options.retracted ? LABEL_HLC : null],
    );
  }

  /** A second live record naming `recordId`'s key, as content addressing allows. */
  async function copyRecord(recordId: string, copyId: string) {
    await pg.query(
      `INSERT INTO shared.records
         SELECT user_id, $2, type, created_at, updated_at, node_id, deleted_at, version,
                content_hash, object_storage_key, mime_type, size_bytes, 'copy.jpg',
                origin_app_id, parent_id, stand_in_role, fidelity, canonical_threshold,
                self_canonical, stand_in_slot
         FROM shared.records WHERE user_id = $1 AND id = $3`,
      [A, copyId, recordId],
    );
  }

  async function presignBatch(keys: string[]) {
    const res = await call(A, "POST", "/files/presign-batch", {
      items: keys.map((key) => ({ key })),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return Object.fromEntries(
      (res.body["answers"] as Array<{ key: string; status: string }>).map((a) => [a.key, a.status]),
    );
  }

  /** From here on S3 holds no file, so each one is uploaded or declined. */
  function s3HoldsNothing() {
    s3Mock
      .on(HeadObjectCommand)
      .rejects(Object.assign(new Error("NotFound"), { name: "NotFound" }));
  }

  it("refuses a key that any one of its live records marks, and only that key", async () => {
    // Key 1: two records share it, and the copy carries the label.
    const shared = await aRegisters("1");
    await copyRecord(shared, "copy-of-1");
    await markNoCloud("copy-of-1");
    // Key 2: the marked record is tombstoned.
    const tombstoned = await aRegisters("2");
    await markNoCloud(tombstoned);
    await pg.query(`UPDATE shared.records SET deleted_at = $2 WHERE user_id = $1 AND id = $3`, [
      A,
      LABEL_HLC,
      tombstoned,
    ]);
    // Key 3: the label is retracted.
    await markNoCloud(await aRegisters("3"), { retracted: true });
    // Key 4: no record at all, and an orphaned label elsewhere.
    await markNoCloud("no-such-record");
    s3HoldsNothing();

    expect(await presignBatch([keyOf("1"), keyOf("2"), keyOf("3"), keyOf("4")])).toEqual({
      [keyOf("1")]: "refused",
      [keyOf("2")]: "signed",
      [keyOf("3")]: "signed",
      [keyOf("4")]: "signed",
    });
    expect((await call(A, "POST", "/files/presign", { key: keyOf("1") })).status).toBe(403);
    expect((await call(A, "POST", "/files/presign", { key: keyOf("3") })).status).toBe(200);
  });

  it("finds a marked record past the first page of no-cloud labels", async () => {
    await pg.query(
      `INSERT INTO shared.record_labels
         (user_id, record_id, app_id, key, value, record_type, created_at, updated_at, node_id)
       SELECT $1, 'orphan-' || lpad(n::text, 4, '0'), 'starkeep', 'no-cloud', '', 'image/jpeg', $2, $2, 'n'
       FROM generate_series(1, 600) AS n`,
      [A, LABEL_HLC],
    );
    const id = await aRegisters("5");
    // Sorts after every orphan, so it lands on the last page.
    await copyRecord(id, "zzzz-marked");
    await markNoCloud("zzzz-marked");
    s3HoldsNothing();

    expect(await presignBatch([keyOf("5")])).toEqual({ [keyOf("5")]: "refused" });
  });
});
