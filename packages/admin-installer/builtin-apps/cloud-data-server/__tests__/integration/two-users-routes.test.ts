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
import { createSharedSchema } from "../../../../../storage-aurora-dsql/__tests__/pg-shared-schema.js";
import { createHash, sign } from "node:crypto";
import { PutParameterCommand, ParameterAlreadyExists } from "@aws-sdk/client-ssm";
import {
  mobileSignedMessage,
  serializeHLC,
  type HLCTimestamp,
} from "@starkeep/protocol-primitives";
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

function as(userId: string, method: string, subPath: string, body?: unknown): APIGatewayEvent {
  const bodyless = method === "GET" || method === "HEAD" || method === "DELETE";
  const bodyStr = body === undefined ? undefined : JSON.stringify(body);
  const headers = signRequest({
    appId: DRIVE,
    hmacSecret: `secret-${DRIVE}`,
    method,
    path: subPath,
    ...(bodyless ? {} : { body: bodyStr }),
  });
  return {
    rawPath: `/apps/${DRIVE}${subPath}`,
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

async function call(userId: string, method: string, subPath: string, body?: unknown) {
  const res = await handler(as(userId, method, subPath, body), context);
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
      async call(method: string, subPath: string, body?: unknown) {
        const bodyStr = body === undefined ? "" : JSON.stringify(body);
        const ts = Date.now();
        const message = mobileSignedMessage(DRIVE, method, subPath, ts, Buffer.from(bodyStr));
        const out = await handler(
          {
            rawPath: `/apps/${DRIVE}${subPath}`,
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

  it("B's phone, with B's key, syncs none of A's photos", async () => {
    await registerPhotosMobile();
    await aWritesAPhoto();
    const phone = await phoneOf(B);
    const res = await phone.call("POST", "/sync/exchange", { watermarks: {} });
    expect(res.status).toBe(200);
    expect(res.body["records"]).toEqual([]);
  });
});
