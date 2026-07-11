/**
 * DB-level route tests (plan §10 session-2 slice): grants parity on the
 * records/metadata routes, register 409/dedup, the sync-exchange channel
 * split, and /app-data CRUD — all against the exported handler with DSQL
 * replaced through the __setDatabaseClientFactoryForTests seam and S3/SSM/STS
 * mocked with aws-sdk-client-mock. DSQL-specific semantics stay Tier 3.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";
import { signRequest } from "@starkeep/app-client";
import { dataRecordObjectKey } from "@starkeep/protocol-primitives";
import type { APIGatewayEvent, LambdaContext } from "../src/handler-utils.js";
import { fakeDsqlWithGrants, recordRow } from "./fake-dsql.js";

const ssmMock = mockClient(SSMClient);
const stsMock = mockClient(STSClient);
const s3Mock = mockClient(S3Client);

const context: LambdaContext = {
  invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:teststack-cds",
};

// Real RSA key pair so the CloudFront signer produces valid signatures in the
// shared file-url tests. The public half is unused here (CloudFront would
// verify it) — we only need a well-formed private key.
const cfKeyPair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
const CF_DOMAIN = "d1234testcdn.cloudfront.net";
const CF_KEY_PAIR_ID = "K2TESTKEYPAIRID";
const CF_SIGNING_PARAM = "/teststack/app-creds/_cloudfront-signing";

type HandlerModule = typeof import("../src/api-handler.js");
let handler: HandlerModule["handler"];
let setDbFactory: HandlerModule["__setDatabaseClientFactoryForTests"];

beforeAll(async () => {
  process.env.STACK_PREFIX = "teststack";
  process.env.AURORA_ENDPOINT = "invalid.test.localdomain";
  process.env.S3_BUCKET = "fake-bucket";
  process.env.AWS_REGION = "us-east-1";
  process.env.CLOUDFRONT_SIGNING_PARAM = CF_SIGNING_PARAM;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const mod = await import("../src/api-handler.js");
  handler = mod.handler;
  setDbFactory = mod.__setDatabaseClientFactoryForTests;
});

afterAll(() => {
  setDbFactory(null);
});

beforeEach(() => {
  ssmMock.reset();
  stsMock.reset();
  s3Mock.reset();
  // Auth is exercised in handler-auth.test.ts; here every request signs
  // correctly. The handler's module-level caches make most of these mocks
  // hit only on each app's first request, which is fine.
  ssmMock.on(GetParameterCommand).callsFake(async (input: { Name?: string }) => {
    if (input.Name === CF_SIGNING_PARAM) {
      return {
        Parameter: {
          Value: JSON.stringify({
            keyPairId: CF_KEY_PAIR_ID,
            domain: CF_DOMAIN,
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
});

function signedEvent(args: {
  appId: string;
  method: string;
  subPath: string;
  body?: unknown;
  query?: Record<string, string>;
}): APIGatewayEvent {
  const isBodyless = args.method === "GET" || args.method === "HEAD";
  const bodyStr = args.body === undefined ? undefined : JSON.stringify(args.body);
  const headers = signRequest({
    appId: args.appId,
    hmacSecret: `secret-${args.appId}`,
    method: args.method,
    path: args.subPath,
    ...(isBodyless ? {} : { body: bodyStr }),
  });
  return {
    rawPath: `/apps/${args.appId}${args.subPath}`,
    requestContext: { http: { method: args.method } },
    headers,
    ...(bodyStr !== undefined ? { body: bodyStr } : {}),
    ...(args.query ? { queryStringParameters: args.query } : {}),
  };
}

function bodyOf(res: { body: string }): Record<string, unknown> {
  return JSON.parse(res.body) as Record<string, unknown>;
}

const RECORDS_SELECT = /select \* from "shared"\."records"/;
const RECORDS_INSERT = /INSERT INTO shared\.records/;
const VALID_HASH = "b".repeat(64);

describe("grants parity on records routes", () => {
  it("403s an explicit ?type= outside the readable set without querying records", async () => {
    const db = fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "readwrite" }]);
    setDbFactory(db);
    const res = await handler(
      signedEvent({ appId: "gp1", method: "GET", subPath: "/data/records", query: { type: "audio/mp3" } }),
      context,
    );
    expect(res.statusCode).toBe(403);
    expect(db.calls(RECORDS_SELECT)).toHaveLength(0);
  });

  it("returns empty records for a grantless app without scanning", async () => {
    const db = fakeDsqlWithGrants([]);
    setDbFactory(db);
    const res = await handler(
      signedEvent({ appId: "gp2", method: "GET", subPath: "/data/records" }),
      context,
    );
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ records: [], hasMore: false, nextCursor: null });
    expect(db.calls(RECORDS_SELECT)).toHaveLength(0);
  });

  it("constrains an untyped scan to the readable types and maps rows", async () => {
    const db = fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "readwrite" }]).on(
      RECORDS_SELECT,
      [recordRow({ id: "rec-1", type: "image/jpeg", mime_type: "image/jpeg" })],
    );
    setDbFactory(db);
    const res = await handler(
      signedEvent({ appId: "gp3", method: "GET", subPath: "/data/records" }),
      context,
    );
    expect(res.statusCode).toBe(200);
    const body = bodyOf(res) as { records: Array<Record<string, unknown>> };
    expect(body.records).toHaveLength(1);
    expect(body.records[0]).toMatchObject({
      id: "rec-1",
      type: "image/jpeg",
      category: "image",
      mime_type: "image/jpeg",
    });
    // The IN filter carries exactly the readable extensions.
    expect(db.calls(RECORDS_SELECT)[0]!.values).toContain("image/jpeg");
  });

  it("GET /data/types short-circuits with no grants and counts by type otherwise", async () => {
    const dbNone = fakeDsqlWithGrants([]);
    setDbFactory(dbNone);
    const resNone = await handler(
      signedEvent({ appId: "gp4", method: "GET", subPath: "/data/types" }),
      context,
    );
    expect(bodyOf(resNone)).toEqual({ types: [], total: 0 });
    expect(dbNone.calls(RECORDS_SELECT)).toHaveLength(0);

    const dbSome = fakeDsqlWithGrants([
      { type_id: "image/jpeg", access: "read" },
      { type_id: "image/png", access: "read" },
    ]).on(RECORDS_SELECT, [
      recordRow({ id: "t1", type: "image/jpeg" }),
      recordRow({ id: "t2", type: "image/jpeg" }),
      recordRow({ id: "t3", type: "image/png" }),
    ]);
    setDbFactory(dbSome);
    const resSome = await handler(
      signedEvent({ appId: "gp5", method: "GET", subPath: "/data/types" }),
      context,
    );
    const body = bodyOf(resSome) as { types: unknown[]; total: number };
    expect(body.total).toBe(3);
    expect(body.types).toContainEqual({ record_type: "image/jpeg", count: 2 });
    expect(body.types).toContainEqual({ record_type: "image/png", count: 1 });
  });

  it("403s a record registration for a read-only type before touching S3", async () => {
    setDbFactory(fakeDsqlWithGrants([{ type_id: "document/pdf", access: "read" }]));
    const res = await handler(
      signedEvent({
        appId: "gp6",
        method: "POST",
        subPath: "/data/records",
        body: { type: "document/pdf", contentType: "application/pdf", contentHash: VALID_HASH, sizeBytes: 3 },
      }),
      context,
    );
    expect(res.statusCode).toBe(403);
    expect(s3Mock.calls()).toHaveLength(0);
  });
});

describe("record registration", () => {
  const grants = [{ type_id: "image/jpeg", access: "readwrite" as const }];

  it("409s when no blob exists at the content-addressed key", async () => {
    setDbFactory(fakeDsqlWithGrants(grants));
    s3Mock
      .on(HeadObjectCommand)
      .rejects(Object.assign(new Error("NotFound"), { name: "NotFound" }));
    const res = await handler(
      signedEvent({
        appId: "reg1",
        method: "POST",
        subPath: "/data/records",
        body: { type: "image/jpeg", contentType: "image/jpeg", contentHash: VALID_HASH, sizeBytes: 3 },
      }),
      context,
    );
    expect(res.statusCode).toBe(409);
  });

  it("201s and persists when the blob exists", async () => {
    const db = fakeDsqlWithGrants(grants).on(RECORDS_INSERT, []);
    setDbFactory(db);
    s3Mock.on(HeadObjectCommand).resolves({});
    const res = await handler(
      signedEvent({
        appId: "reg2",
        method: "POST",
        subPath: "/data/records",
        body: {
          type: "image/jpeg",
          contentType: "image/jpeg",
          contentHash: VALID_HASH,
          sizeBytes: 3,
          fileName: "cat.jpg",
        },
      }),
      context,
    );
    expect(res.statusCode).toBe(201);
    const { record } = bodyOf(res) as { record: Record<string, unknown> };
    expect(record).toMatchObject({
      type: "image/jpeg",
      category: "image",
      content_hash: VALID_HASH,
      object_storage_key: dataRecordObjectKey("image/jpeg", VALID_HASH),
      original_filename: "cat.jpg",
      version: 1,
    });
    expect(s3Mock.commandCalls(HeadObjectCommand)[0]!.args[0].input.Key).toBe(
      dataRecordObjectKey("image/jpeg", VALID_HASH),
    );
    const inserts = db.calls(RECORDS_INSERT);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.values).toContain(VALID_HASH);
  });

  it("dedups a byte-identical derived child of the same parent", async () => {
    const db = fakeDsqlWithGrants(grants).on(RECORDS_SELECT, [
      recordRow({ id: "existing-thumb", type: "image/jpeg", content_hash: VALID_HASH, parent_id: "parent-1" }),
    ]);
    setDbFactory(db);
    s3Mock.on(HeadObjectCommand).resolves({});
    const res = await handler(
      signedEvent({
        appId: "reg3",
        method: "POST",
        subPath: "/data/records",
        body: {
          type: "image/jpeg",
          contentType: "image/jpeg",
          contentHash: VALID_HASH,
          sizeBytes: 3,
          parentId: "parent-1",
        },
      }),
      context,
    );
    expect(res.statusCode).toBe(200); // existing record, not 201
    const { record } = bodyOf(res) as { record: Record<string, unknown> };
    expect(record["id"]).toBe("existing-thumb");
    expect(db.calls(RECORDS_INSERT)).toHaveLength(0);
  });
});

const IMAGE_META_SELECT = /from shared\.record_image_metadata where record_id in/i;

describe("list metadata enrichment (?include=metadata)", () => {
  it("embeds each record's per-category metadata in one batched read", async () => {
    const db = fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "read" }])
      .on(RECORDS_SELECT, [
        recordRow({ id: "rec-1", type: "image/jpeg" }),
        recordRow({ id: "rec-2", type: "image/jpeg" }),
      ])
      .on(IMAGE_META_SELECT, [
        { record_id: "rec-1", width: 600, height: 800, orientation: null },
      ]);
    setDbFactory(db);
    const res = await handler(
      signedEvent({ appId: "m1", method: "GET", subPath: "/data/records", query: { include: "metadata" } }),
      context,
    );
    expect(res.statusCode).toBe(200);
    const body = bodyOf(res) as { records: Array<Record<string, unknown>> };
    // rec-1 gets its dimensions; rec-2 has no metadata row → null, not omitted.
    expect(body.records[0]!.metadata).toMatchObject({ recordId: "rec-1", width: 600, height: 800 });
    expect(body.records[1]!.metadata).toBeNull();
    // One batched metadata read for the whole page (not one per record).
    expect(db.calls(IMAGE_META_SELECT)).toHaveLength(1);
    expect(db.calls(IMAGE_META_SELECT)[0]!.values).toEqual(["rec-1", "rec-2"]);
  });

  it("omits metadata and issues no metadata query by default", async () => {
    const db = fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "read" }]).on(
      RECORDS_SELECT,
      [recordRow({ id: "rec-1", type: "image/jpeg" })],
    );
    setDbFactory(db);
    const res = await handler(
      signedEvent({ appId: "m2", method: "GET", subPath: "/data/records" }),
      context,
    );
    expect(res.statusCode).toBe(200);
    const body = bodyOf(res) as { records: Array<Record<string, unknown>> };
    expect(body.records[0]).not.toHaveProperty("metadata");
    expect(db.calls(IMAGE_META_SELECT)).toHaveLength(0);
  });
});

describe("metadata routes", () => {
  it("403s a metadata write to a category outside the writable set", async () => {
    setDbFactory(fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "read" }]));
    const res = await handler(
      signedEvent({
        appId: "md1",
        method: "POST",
        subPath: "/data/records/r1/metadata",
        body: { typeId: "image/jpeg", metadata: { width: 100 } },
      }),
      context,
    );
    expect(res.statusCode).toBe(403);
  });

  it("400s unknown metadata columns against the category schema", async () => {
    setDbFactory(fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "readwrite" }]));
    const res = await handler(
      signedEvent({
        appId: "md2",
        method: "POST",
        subPath: "/data/records/r1/metadata",
        body: { typeId: "image/jpeg", metadata: { width: 100, bogus_column: 1 } },
      }),
      context,
    );
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res)["error"]).toMatch(/bogus_column/);
  });

  it("writes valid metadata into the derived category's table", async () => {
    const db = fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "readwrite" }]).on(
      /INSERT INTO shared\.record_image_metadata/,
      [],
    );
    setDbFactory(db);
    const res = await handler(
      signedEvent({
        appId: "md3",
        method: "POST",
        subPath: "/data/records/r1/metadata",
        body: { typeId: "image/jpeg", metadata: { width: 100, height: 50 } },
      }),
      context,
    );
    expect(res.statusCode).toBe(200);
    const writes = db.calls(/INSERT INTO shared\.record_image_metadata/);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.values).toEqual(["r1", 100, 50]);
  });

  it('400s metadata writes to "other" even for all-access Drive', async () => {
    setDbFactory(fakeDsqlWithGrants());
    const res = await handler(
      signedEvent({
        appId: "starkeep-drive",
        method: "POST",
        subPath: "/data/records/r1/metadata",
        body: { typeId: "other", metadata: { anything: 1 } },
      }),
      context,
    );
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res)["error"]).toMatch(/no metadata table/);
  });

  it("reads metadata for a readable category and null for other", async () => {
    const db = fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "read" }]).on(
      /FROM shared\.record_image_metadata WHERE record_id/,
      [{ record_id: "r9", width: 640 }],
    );
    setDbFactory(db);
    const res = await handler(
      signedEvent({ appId: "md4", method: "GET", subPath: "/data/records/r9/metadata/image" }),
      context,
    );
    expect(bodyOf(res)["metadata"]).toMatchObject({ recordId: "r9", width: 640 });

    setDbFactory(fakeDsqlWithGrants());
    const resOther = await handler(
      signedEvent({
        appId: "starkeep-drive",
        method: "GET",
        subPath: "/data/records/r9/metadata/other",
      }),
      context,
    );
    expect(bodyOf(resOther)).toEqual({ metadata: null });
  });
});

describe("per-record routes honor read/write grants", () => {
  it("403s file-url for a record whose type the caller cannot read", async () => {
    const db = fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "readwrite" }]).on(
      /FROM shared\.records WHERE id =/,
      [recordRow({ id: "v1", type: "audio/mp3" })],
    );
    setDbFactory(db);
    const res = await handler(
      signedEvent({ appId: "pr1", method: "GET", subPath: "/data/records/v1/file-url" }),
      context,
    );
    expect(res.statusCode).toBe(403);
  });

  it("DELETE tombstones a writable record and 403s otherwise", async () => {
    const db = fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "readwrite" }])
      .on(/FROM shared\.records WHERE id =/, [recordRow({ id: "d1", type: "image/jpeg" })])
      .on(/UPDATE shared\.records SET deleted_at/, []);
    setDbFactory(db);
    const res = await handler(
      signedEvent({ appId: "pr2", method: "DELETE", subPath: "/data/records/d1" }),
      context,
    );
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ deleted: true });
    expect(db.calls(/UPDATE shared\.records SET deleted_at/)).toHaveLength(1);

    const dbRo = fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "read" }]).on(
      /FROM shared\.records WHERE id =/,
      [recordRow({ id: "d2", type: "image/jpeg" })],
    );
    setDbFactory(dbRo);
    const resRo = await handler(
      signedEvent({ appId: "pr3", method: "DELETE", subPath: "/data/records/d2" }),
      context,
    );
    expect(resRo.statusCode).toBe(403);
    expect(dbRo.calls(/UPDATE shared\.records SET deleted_at/)).toHaveLength(0);
  });

  it("chokepoint catches a route/data mismatch: readable type, foreign-category key", async () => {
    // The record's TYPE is readable (image/jpeg), so the route-level canRead
    // check passes — but its object key points at a category the caller cannot
    // read (audio). The pre-sign revalidation chokepoint re-checks the KEY, so
    // the single file-url route 403s instead of signing a foreign-category URL.
    const db = fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "read" }]).on(
      /FROM shared\.records WHERE id =/,
      [recordRow({ id: "mm1", type: "image/jpeg", object_storage_key: `shared/audio/ab/${"a".repeat(64)}` })],
    );
    setDbFactory(db);
    const res = await handler(
      signedEvent({ appId: "mm", method: "GET", subPath: "/data/records/mm1/file-url" }),
      context,
    );
    expect(res.statusCode).toBe(403);
  });

  it("chokepoint omits a route/data mismatch from the batch route", async () => {
    // Same mismatch through the batch route: the foreign-category record is
    // silently omitted (batch semantics) rather than signed.
    const db = fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "read" }]).on(RECORDS_SELECT, [
      recordRow({ id: "ok1", type: "image/jpeg" }),
      recordRow({ id: "bad1", type: "image/jpeg", object_storage_key: `shared/audio/ab/${"a".repeat(64)}` }),
    ]);
    setDbFactory(db);
    const res = await handler(
      signedEvent({
        appId: "mmb",
        method: "POST",
        subPath: "/data/records/file-urls",
        body: { ids: ["ok1", "bad1"] },
      }),
      context,
    );
    expect(res.statusCode).toBe(200);
    const body = bodyOf(res) as { urls: Record<string, unknown> };
    expect(Object.keys(body.urls)).toEqual(["ok1"]);
  });
});

describe("batch file-urls route", () => {
  const grants = [{ type_id: "image/jpeg", access: "read" as const }];

  it("presigns readable records in one query, omitting unreadable/deleted/file-less/unknown ids", async () => {
    const db = fakeDsqlWithGrants(grants).on(RECORDS_SELECT, [
      recordRow({ id: "b1", type: "image/jpeg", mime_type: "image/jpeg", size_bytes: 42 }),
      recordRow({ id: "b2", type: "audio/mp3" }),
      recordRow({ id: "b3", type: "image/jpeg", object_storage_key: null }),
    ]);
    setDbFactory(db);
    const res = await handler(
      signedEvent({
        appId: "bu1",
        method: "POST",
        subPath: "/data/records/file-urls",
        body: { ids: ["b1", "b2", "b3", "b-missing"] },
      }),
      context,
    );
    expect(res.statusCode).toBe(200);
    const body = bodyOf(res) as {
      urls: Record<string, { url: string; mimeType?: string; sizeBytes?: number }>;
      expiresIn: number;
    };
    // Only the readable record with an attached file gets a URL; the audio
    // record (no grant), the key-less record, and the unknown id are omitted.
    expect(Object.keys(body.urls)).toEqual(["b1"]);
    // Shared blobs are now CloudFront-signed (edge domain + signature params),
    // not S3 presigned.
    expect(body.urls["b1"]!.url).toContain(CF_DOMAIN);
    expect(body.urls["b1"]!.url).toContain("Signature=");
    expect(body.urls["b1"]!.url).toContain(`Key-Pair-Id=${CF_KEY_PAIR_ID}`);
    expect(body.urls["b1"]).toMatchObject({ mimeType: "image/jpeg", sizeBytes: 42 });
    // Flat expiry — CloudFront signatures don't die with the STS session, so
    // the shared path no longer clamps to it.
    expect(body.expiresIn).toBe(3600);
    // The whole batch is one records query, not one per id.
    expect(db.calls(RECORDS_SELECT)).toHaveLength(1);
    // The IN filter carries the deduplicated ids.
    expect(db.calls(RECORDS_SELECT)[0]!.values).toEqual(
      expect.arrayContaining(["b1", "b2", "b3", "b-missing"]),
    );
  });

  it("deduplicates repeated ids before querying", async () => {
    const db = fakeDsqlWithGrants(grants).on(RECORDS_SELECT, [
      recordRow({ id: "b1", type: "image/jpeg" }),
    ]);
    setDbFactory(db);
    const res = await handler(
      signedEvent({
        appId: "bu2",
        method: "POST",
        subPath: "/data/records/file-urls",
        body: { ids: ["b1", "b1", "b1"] },
      }),
      context,
    );
    expect(res.statusCode).toBe(200);
    const values = db.calls(RECORDS_SELECT)[0]!.values;
    expect(values.filter((v) => v === "b1")).toHaveLength(1);
  });

  it("400s on a missing, empty, non-string, or oversized ids array without querying", async () => {
    const cases: unknown[] = [
      {},
      { ids: [] },
      { ids: "b1" },
      { ids: [1, 2] },
      { ids: Array.from({ length: 501 }, (_, i) => `id-${i}`) },
    ];
    for (const body of cases) {
      const db = fakeDsqlWithGrants(grants);
      setDbFactory(db);
      const res = await handler(
        signedEvent({ appId: "bu3", method: "POST", subPath: "/data/records/file-urls", body }),
        context,
      );
      expect(res.statusCode, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect(db.calls(RECORDS_SELECT)).toHaveLength(0);
    }
  });
});

describe("OCC retry on record read-modify-write", () => {
  const grants = [{ type_id: "image/jpeg", access: "readwrite" as const }];
  const RECORD_BY_ID = /FROM shared\.records WHERE id =/;

  function occConflict(): Error {
    return Object.assign(new Error("change conflicts with another transaction"), {
      code: "OC001",
    });
  }

  it("PUT re-reads on an OCC conflict so version advances (no lost update)", async () => {
    // The upsert loses the OCC race exactly once. Between the failed attempt and
    // the retry, a concurrent writer commits version 2, so the re-read sees 2
    // and the retry must derive version 3 — not replay the stale 2.
    let committedVersion = 1;
    let insertAttempts = 0;
    const db = fakeDsqlWithGrants(grants)
      .on(RECORD_BY_ID, () => [
        recordRow({ id: "rmw1", type: "image/jpeg", version: committedVersion }),
      ])
      .on(RECORDS_INSERT, () => {
        insertAttempts++;
        if (insertAttempts === 1) {
          committedVersion = 2; // a concurrent writer wins the race
          throw occConflict();
        }
        return [];
      });
    setDbFactory(db);

    const res = await handler(
      signedEvent({
        appId: "rmw",
        method: "PUT",
        subPath: "/data/records/rmw1",
        body: { originalFilename: "renamed.jpg" },
      }),
      context,
    );

    expect(res.statusCode).toBe(200);
    const { record } = bodyOf(res) as { record: Record<string, unknown> };
    expect(record["version"]).toBe(3); // re-read 2 + 1, not stale 1 + 1
    // The unit re-read: two SELECTs, two upsert attempts.
    expect(db.calls(RECORD_BY_ID)).toHaveLength(2);
    expect(db.calls(RECORDS_INSERT)).toHaveLength(2);
  });

  it("maps a non-OCC write failure to 500 without retrying", async () => {
    let insertAttempts = 0;
    const db = fakeDsqlWithGrants(grants)
      .on(RECORD_BY_ID, [recordRow({ id: "rmw2", type: "image/jpeg", version: 1 })])
      .on(RECORDS_INSERT, () => {
        insertAttempts++;
        throw Object.assign(new Error("relation missing"), { code: "42P01" });
      });
    setDbFactory(db);

    const res = await handler(
      signedEvent({
        appId: "rmw",
        method: "PUT",
        subPath: "/data/records/rmw2",
        body: { originalFilename: "x.jpg" },
      }),
      context,
    );

    expect(res.statusCode).toBe(500);
    expect(insertAttempts).toBe(1); // no retry on a non-OCC error
  });
});

describe("sync exchange channel split", () => {
  const hlc = { wallTime: Date.UTC(2026, 0, 2), counter: 0, nodeId: "peer" };
  const incomingRecord = {
    id: "sync-rec-1",
    kind: "data",
    type: "image/jpeg",
    originAppId: "photos",
    createdAt: hlc,
    updatedAt: hlc,
    deletedAt: null,
    version: 1,
    contentHash: VALID_HASH,
    objectStorageKey: dataRecordObjectKey("image/jpeg", VALID_HASH),
    mimeType: "image/jpeg",
    sizeBytes: 3,
    originalFilename: null,
    parentId: null,
  };

  it("the Drive channel applies incoming shared records", async () => {
    const db = fakeDsqlWithGrants()
      .on(/FROM shared\.records WHERE id =/, [])
      .on(RECORDS_INSERT, [])
      .on(RECORDS_SELECT, []);
    setDbFactory(db);
    const res = await handler(
      signedEvent({
        appId: "starkeep-drive",
        method: "POST",
        subPath: "/sync/exchange",
        body: { watermarks: {}, records: [incomingRecord] },
      }),
      context,
    );
    expect(res.statusCode).toBe(200);
    const inserts = db.calls(RECORDS_INSERT);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.values).toContain("sync-rec-1");
    expect(bodyOf(res)).toMatchObject({ records: [], hasMore: false });
  });

  it("a per-app channel drops shared records and never scans shared.records", async () => {
    const db = fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "readwrite" }]).on(
      /FROM shared\.app_syncable_namespaces/,
      [],
    );
    setDbFactory(db);
    const res = await handler(
      signedEvent({
        appId: "chsplit1",
        method: "POST",
        subPath: "/sync/exchange",
        body: { watermarks: {}, records: [incomingRecord] },
      }),
      context,
    );
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toMatchObject({ records: [], appSyncableRows: [] });
    expect(db.calls(RECORDS_INSERT)).toHaveLength(0);
    expect(db.calls(/FROM shared\.records WHERE id =/)).toHaveLength(0);
    expect(db.calls(RECORDS_SELECT)).toHaveLength(0);
  });
});

describe("/app-data routes", () => {
  const NS_SELECT = /FROM shared\.app_syncable_namespaces/;
  const notesNamespace = {
    app_id: "appdata1",
    tables_json: JSON.stringify([{ name: "notes", pkColumns: ["id"] }]),
    files_enabled: false,
  };

  it("404s an app that declared no appSpecificSyncable namespace", async () => {
    setDbFactory(fakeDsqlWithGrants().on(NS_SELECT, []));
    const res = await handler(
      signedEvent({ appId: "appdata0", method: "GET", subPath: "/app-data/db/notes" }),
      context,
    );
    expect(res.statusCode).toBe(404);
    expect(bodyOf(res)["error"]).toMatch(/did not declare appSpecificSyncable/);
  });

  it("inserts rows into a declared table via the LWW applier", async () => {
    const db = fakeDsqlWithGrants()
      .on(NS_SELECT, [notesNamespace])
      .on(/INSERT INTO app_appdata1\."notes"/, []);
    setDbFactory(db);
    const res = await handler(
      signedEvent({
        appId: "appdata1",
        method: "POST",
        subPath: "/app-data/db/notes",
        body: { row: { id: "n1", text: "hi" } },
      }),
      context,
    );
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ ok: true });
    const inserts = db.calls(/INSERT INTO app_appdata1\."notes"/);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.values.slice(0, 2)).toEqual(["n1", "hi"]); // + updated_at, deleted_at
  });

  it("queries live rows of a declared table", async () => {
    const db = fakeDsqlWithGrants()
      .on(NS_SELECT, [notesNamespace])
      .on(/SELECT \* FROM app_appdata1\."notes" WHERE deleted_at IS NULL/, [
        { id: "n1", text: "hi" },
      ]);
    setDbFactory(db);
    const res = await handler(
      signedEvent({ appId: "appdata1", method: "GET", subPath: "/app-data/db/notes" }),
      context,
    );
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ rows: [{ id: "n1", text: "hi" }] });
  });

  it("updates and soft-deletes rows through the applier", async () => {
    const db = fakeDsqlWithGrants()
      .on(NS_SELECT, [notesNamespace])
      .on(/UPDATE app_appdata1\."notes" SET/, []);
    setDbFactory(db);
    const patchRes = await handler(
      signedEvent({
        appId: "appdata1",
        method: "PATCH",
        subPath: "/app-data/db/notes",
        body: { where: { id: "n1" }, patch: { text: "new" } },
      }),
      context,
    );
    expect(patchRes.statusCode).toBe(200);
    expect(bodyOf(patchRes)).toEqual({ changes: 1 });

    const deleteRes = await handler(
      signedEvent({
        appId: "appdata1",
        method: "DELETE",
        subPath: "/app-data/db/notes",
        body: { where: { id: "n1" } },
      }),
      context,
    );
    expect(deleteRes.statusCode).toBe(200);
    expect(bodyOf(deleteRes)).toEqual({ changes: 1 });
    const updates = db.calls(/UPDATE app_appdata1\."notes" SET/);
    expect(updates).toHaveLength(2);
    expect(updates[1]!.text).toMatch(/SET deleted_at/);
  });

  it("400s writes to an undeclared table", async () => {
    setDbFactory(fakeDsqlWithGrants().on(NS_SELECT, [notesNamespace]));
    const res = await handler(
      signedEvent({
        appId: "appdata1",
        method: "POST",
        subPath: "/app-data/db/secrets",
        body: { row: { id: "x" } },
      }),
      context,
    );
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res)["error"]).toMatch(/did not declare app-syncable table/);
  });

  it("400s file operations when the app did not opt in to syncable files", async () => {
    setDbFactory(fakeDsqlWithGrants().on(NS_SELECT, [notesNamespace]));
    const res = await handler(
      signedEvent({
        appId: "appdata1",
        method: "POST",
        subPath: "/app-data/files/presign",
        body: { subKey: "pic.png", contentType: "image/png" },
      }),
      context,
    );
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res)["error"]).toMatch(/did not opt in to syncable files/);
  });

  // ---- Direct-to-S3 presign flow (todo 24/25) ----
  const filesNamespace = {
    app_id: "appdata1",
    // The installer persists the reserved index table into tables_json for any
    // files_enabled app (withFileRecordsTable), so the applier knows its pk.
    tables_json: JSON.stringify([
      { name: "notes", pkColumns: ["id"] },
      { name: "_starkeep_sync_records", pkColumns: ["id"] },
    ]),
    files_enabled: true,
  };
  // The reserved index table the applier reads/writes for app-private files.
  const FILE_RECORDS_SELECT = /SELECT \* FROM app_appdata1\."_starkeep_sync_records"/;
  const FILE_RECORDS_INSERT = /INSERT INTO app_appdata1\."_starkeep_sync_records"/;
  const fileRow = {
    id: "apps/appdata1/syncable/cover",
    object_storage_key: "apps/appdata1/syncable/cover",
    content_hash: "c".repeat(64),
    mime_type: "image/png",
    size_bytes: 21,
    original_filename: null,
    origin_app_id: "appdata1",
    deleted_at: null,
  };

  it("presigns an app-data file PUT URL, keyed under the app's syncable prefix", async () => {
    const db = fakeDsqlWithGrants().on(NS_SELECT, [filesNamespace]).on(FILE_RECORDS_SELECT, []);
    setDbFactory(db);
    const res = await handler(
      signedEvent({
        appId: "appdata1",
        method: "POST",
        subPath: "/app-data/files/presign",
        body: { subKey: "cover", contentType: "image/png" },
      }),
      context,
    );
    expect(res.statusCode).toBe(200);
    const body = bodyOf(res);
    expect(body["key"]).toBe("apps/appdata1/syncable/cover");
    expect(String(body["url"])).toContain("fake-bucket");
    // The broker never reads or writes bytes on the presign path.
    expect(db.calls(FILE_RECORDS_INSERT)).toHaveLength(0);
  });

  it("registers the index row for a presigned upload without holding bytes", async () => {
    const db = fakeDsqlWithGrants().on(NS_SELECT, [filesNamespace]).on(FILE_RECORDS_INSERT, []);
    setDbFactory(db);
    const res = await handler(
      signedEvent({
        appId: "appdata1",
        method: "POST",
        subPath: "/app-data/files/cover/record",
        body: { contentHash: "c".repeat(64), mimeType: "image/png", sizeBytes: 21 },
      }),
      context,
    );
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)["key"]).toBe("apps/appdata1/syncable/cover");
    expect(db.calls(FILE_RECORDS_INSERT)).toHaveLength(1);
  });

  it("400s register without the required metadata", async () => {
    setDbFactory(fakeDsqlWithGrants().on(NS_SELECT, [filesNamespace]));
    const res = await handler(
      signedEvent({
        appId: "appdata1",
        method: "POST",
        subPath: "/app-data/files/cover/record",
        body: { mimeType: "image/png" },
      }),
      context,
    );
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res)["error"]).toMatch(/contentHash, mimeType, and sizeBytes/);
  });

  it("GET presigns from the index row (no byte download), 404s when absent", async () => {
    const present = fakeDsqlWithGrants().on(NS_SELECT, [filesNamespace]).on(FILE_RECORDS_SELECT, [fileRow]);
    setDbFactory(present);
    const found = await handler(
      signedEvent({ appId: "appdata1", method: "GET", subPath: "/app-data/files/cover" }),
      context,
    );
    expect(found.statusCode).toBe(200);
    expect(typeof bodyOf(found)["url"]).toBe("string");

    const absent = fakeDsqlWithGrants().on(NS_SELECT, [filesNamespace]).on(FILE_RECORDS_SELECT, []);
    setDbFactory(absent);
    const gone = await handler(
      signedEvent({ appId: "appdata1", method: "GET", subPath: "/app-data/files/cover" }),
      context,
    );
    expect(gone.statusCode).toBe(404);
  });
});
