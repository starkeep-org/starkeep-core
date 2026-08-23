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
import {
  S3Client,
  HeadObjectCommand,
  PutObjectTaggingCommand,
  RestoreObjectCommand,
} from "@aws-sdk/client-s3";
import { signRequest } from "@starkeep/app-client";
import { installUserTokenFixture } from "./user-token.js";
import { dataRecordObjectKey, serializeHLC } from "@starkeep/protocol-primitives";
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

// Every route below sits behind the broker's end-user gate, so each request
// carries a valid ID token alongside its HMAC. The gate itself is examined in
// handler-auth.test.ts; here it is setup.
let userToken = "";
beforeAll(async () => {
  ({ token: userToken } = await installUserTokenFixture());
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
    headers: { ...headers, "X-Starkeep-User-Token": userToken },
    ...(bodyStr !== undefined ? { body: bodyStr } : {}),
    ...(args.query ? { queryStringParameters: args.query } : {}),
  };
}

function bodyOf(res: { body: string }): Record<string, unknown> {
  return JSON.parse(res.body) as Record<string, unknown>;
}

const RECORDS_SELECT = /select \* from "shared"\."records"/;
const RECORDS_INSERT = /insert into "shared"\."records"/;
// The responder's coverage-watermark summary, computed on every exchange.
const RECORDS_NODE_WATERMARKS =
  /select "node_id", max\("updated_at"\).*from "shared"\."records" group by "node_id"/;
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

  it("writes labels supplied on create, without a second request", async () => {
    // Successor to the old `label` column round-trip. The record and its
    // labels share a request but not a transaction — see §4a of the plan for
    // why a transaction would buy nothing durable here.
    const db = fakeDsqlWithGrants(grants)
      .on(RECORDS_INSERT, [])
      .on(/from "shared"\."app_label_keys"/, [{ app_id: "photos", key: "thumbnail", description: "d" }])
      // The record-type lookup every label write makes — the read the
      // single-statement upsert hides, and the dominant cost of a bulk job.
      .on(/from "shared"\."records" where "id" in/, (q) => [
        recordRow({ id: String(q.values[0]), type: "image/jpeg" }),
      ])
      // The second read the write path makes: this app's stored values for the
      // batch's records, so the per-key value cap counts rows already there
      // rather than only the ones in the batch. A brand-new record has none.
      .on(/from "shared"\."record_labels" where "record_id" in/, [])
      .on(/insert into "shared"\."record_labels"/, []);
    setDbFactory(db);
    s3Mock.on(HeadObjectCommand).resolves({});
    const res = await handler(
      signedEvent({
        appId: "photos",
        method: "POST",
        subPath: "/data/records",
        body: {
          type: "image/jpeg",
          contentType: "image/jpeg",
          contentHash: VALID_HASH,
          sizeBytes: 3,
          labels: [{ key: "thumbnail" }],
        },
      }),
      context,
    );
    expect(res.statusCode).toBe(201);
    const labelInsert = db.calls(/insert into "shared"\."record_labels"/)[0];
    expect(labelInsert, "no label was written").toBeTruthy();
    expect(labelInsert!.values).toContain("thumbnail");
    // The namespace comes from the authenticated subject, not the body.
    expect(labelInsert!.values).toContain("photos");
  });

  // The label-squatting test that used to sit here is deleted, not ported. It
  // asserted that "notes" gets a 400 for minting a "photos/…" label — a check
  // that only existed because the namespace was a string prefix the client
  // supplied. In `shared.record_labels` the namespace is an `app_id` column
  // the server sets from the authenticated subject, so there is no request
  // that can express the attack. Nothing to test.

  // Item 20. The reaper is blocked without this: keys are content-addressed,
  // so two registrations of the same bytes name the same object — and if both
  // create records, deleting either has to decide whether the bytes may go.
  // That is a refcount the reaper cannot compute cheaply and must never get
  // wrong. One key, one record makes "delete the record, delete the object"
  // sound.
  it("dedups a byte-identical top-level record, not just a derived child", async () => {
    const db = fakeDsqlWithGrants(grants, [], [
      recordRow({ id: "already-here", type: "image/jpeg", content_hash: VALID_HASH }),
    ]);
    setDbFactory(db);
    s3Mock.on(HeadObjectCommand).resolves({});
    const res = await handler(
      signedEvent({
        appId: "reg9",
        method: "POST",
        subPath: "/data/records",
        body: {
          type: "image/jpeg",
          contentType: "image/jpeg",
          contentHash: VALID_HASH,
          sizeBytes: 3,
        },
      }),
      context,
    );
    // Idempotent, not an error: the second arrival is a retry or a re-import,
    // neither of which is a mistake the caller can act on.
    expect(res.statusCode).toBe(200);
    expect((bodyOf(res)["record"] as { id: string }).id).toBe("already-here");
    expect(db.calls(RECORDS_INSERT)).toHaveLength(0);
  });

  // The parent edge is part of what a record *is*: the same bytes may
  // legitimately be both a standalone photo and a rendition of something else.
  // Those are different records that happen to share storage, and collapsing
  // them would make one disappear.
  it("does not collapse a top-level record into a child with the same bytes", async () => {
    const db = fakeDsqlWithGrants(grants, [], []);
    setDbFactory(db);
    s3Mock.on(HeadObjectCommand).resolves({});
    await handler(
      signedEvent({
        appId: "reg10",
        method: "POST",
        subPath: "/data/records",
        body: {
          type: "image/jpeg",
          contentType: "image/jpeg",
          contentHash: VALID_HASH,
          sizeBytes: 3,
        },
      }),
      context,
    );
    // The dedup lookup is scoped by parent — a top-level registration asks for
    // parent_id IS NULL rather than matching any record with these bytes.
    const dedupCall = db.calls(/from "shared"\."records" where "content_hash" =/)[0]!;
    expect(dedupCall.text).toContain('"parent_id" is null');
  });

  it("dedups a byte-identical derived child of the same parent", async () => {
    const db = fakeDsqlWithGrants(grants, [], [
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

const IMAGE_META_SELECT = /from "shared"\."record_image_metadata" where "record_id" in/i;

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
      /insert into "shared"\."record_image_metadata"/,
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
    const writes = db.calls(/insert into "shared"\."record_image_metadata"/);
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
      /from "shared"\."record_image_metadata" where "record_id"/,
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
      /from "shared"\."records" where "id" =/,
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
      .on(/from "shared"\."records" where "id" =/, [recordRow({ id: "d1", type: "image/jpeg" })])
      .on(/update "shared"\."records" set "deleted_at"/, []);
    setDbFactory(db);
    const res = await handler(
      signedEvent({ appId: "pr2", method: "DELETE", subPath: "/data/records/d1" }),
      context,
    );
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ deleted: true });
    expect(db.calls(/update "shared"\."records" set "deleted_at"/)).toHaveLength(1);

    const dbRo = fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "read" }]).on(
      /from "shared"\."records" where "id" =/,
      [recordRow({ id: "d2", type: "image/jpeg" })],
    );
    setDbFactory(dbRo);
    const resRo = await handler(
      signedEvent({ appId: "pr3", method: "DELETE", subPath: "/data/records/d2" }),
      context,
    );
    expect(resRo.statusCode).toBe(403);
    expect(dbRo.calls(/update "shared"\."records" set "deleted_at"/)).toHaveLength(0);
  });

  it("chokepoint catches a route/data mismatch: readable type, foreign-category key", async () => {
    // The record's TYPE is readable (image/jpeg), so the route-level canRead
    // check passes — but its object key points at a category the caller cannot
    // read (audio). The pre-sign revalidation chokepoint re-checks the KEY, so
    // the single file-url route 403s instead of signing a foreign-category URL.
    const db = fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "read" }]).on(
      /from "shared"\."records" where "id" =/,
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
  const RECORD_BY_ID = /from "shared"\."records" where "id" =/;

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
    label: null,
  };

  it("the Drive channel applies incoming shared records", async () => {
    const db = fakeDsqlWithGrants()
      .on(/from "shared"\."records" where "id" =/, [])
      .on(RECORDS_INSERT, [])
      .on(RECORDS_SELECT, [])
      .on(RECORDS_NODE_WATERMARKS, [
        // Post-apply per-node coverage the responder reports back.
        { node_id: "peer", max_updated_at: serializeHLC(hlc) },
      ]);
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
    // responderWatermarks serializes through ok() so the requester can
    // replace its peerWatermarks from the response.
    expect(bodyOf(res)).toMatchObject({
      records: [],
      hasMore: false,
      responderWatermarks: { peer: hlc },
    });
  });

  it("a wiped cloud reports empty responder watermarks and accepts the re-ship next round", async () => {
    // Round 1 against an empty (redeployed) store: nothing to ship back and
    // — the fix under test — coverage is reported as empty so the requester
    // drops its stale peerWatermarks.
    const emptyDb = fakeDsqlWithGrants()
      .on(RECORDS_SELECT, [])
      .on(RECORDS_NODE_WATERMARKS, []);
    setDbFactory(emptyDb);
    const res1 = await handler(
      signedEvent({
        appId: "starkeep-drive",
        method: "POST",
        subPath: "/sync/exchange",
        body: { watermarks: { peer: hlc } }, // stale-high advertisement
      }),
      context,
    );
    expect(res1.statusCode).toBe(200);
    expect(bodyOf(res1)).toMatchObject({ responderWatermarks: {} });

    // Round 2: the requester re-ships; the store accepts and now covers it.
    const db = fakeDsqlWithGrants()
      .on(/from "shared"\."records" where "id" =/, [])
      .on(RECORDS_INSERT, [])
      .on(RECORDS_SELECT, [])
      .on(RECORDS_NODE_WATERMARKS, [
        { node_id: "peer", max_updated_at: serializeHLC(hlc) },
      ]);
    setDbFactory(db);
    const res2 = await handler(
      signedEvent({
        appId: "starkeep-drive",
        method: "POST",
        subPath: "/sync/exchange",
        body: { watermarks: {}, records: [incomingRecord] },
      }),
      context,
    );
    expect(res2.statusCode).toBe(200);
    expect(db.calls(RECORDS_INSERT)).toHaveLength(1);
    expect(bodyOf(res2)).toMatchObject({
      responderWatermarks: { peer: hlc },
    });
  });

  it("a per-app channel drops shared records and never scans shared.records", async () => {
    const db = fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "readwrite" }]).on(
      /from "shared"\."app_syncable_namespaces"/,
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
    expect(db.calls(/from "shared"\."records" where "id" =/)).toHaveLength(0);
    expect(db.calls(RECORDS_SELECT)).toHaveLength(0);
  });
});

describe("sync exchange request validation", () => {
  const DIGEST = /group by "node_id", substr/;
  const hlc = { wallTime: Date.UTC(2026, 0, 2), counter: 0, nodeId: "peer" };

  /** A store with nothing in it — every response here is about the request. */
  function emptyStore() {
    const db = fakeDsqlWithGrants()
      .on(RECORDS_SELECT, [])
      .on(RECORDS_NODE_WATERMARKS, [])
      .on(DIGEST, []);
    setDbFactory(db);
    return db;
  }

  function exchange(body: unknown) {
    return handler(
      signedEvent({
        appId: "starkeep-drive",
        method: "POST",
        subPath: "/sync/exchange",
        body,
      }),
      context,
    );
  }

  it("400s a body it cannot read, rather than 500ing out of the query layer", async () => {
    // Signed, so not an anonymous surface — but a peer on an older build or a
    // field that drifted type used to reach `LIMIT ?` and `substr(…, 1, N)`
    // and come back as a 500. The failure is the caller's, and now says so.
    emptyStore();
    for (const body of [
      { watermarks: { peer: "not-an-hlc" } },
      { watermarks: [] },
      { watermarks: {}, records: { id: "x" } },
      { watermarks: {}, limit: "lots" },
    ]) {
      const res = await exchange(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it("clamps a limit far above the responder's own maximum", async () => {
    // `limit: 1e9` was a per-author scan of that size for the asking. An
    // author has to actually owe something for a scan to be planned at all,
    // hence the watermark row.
    const db = fakeDsqlWithGrants()
      .on(RECORDS_SELECT, [])
      .on(RECORDS_NODE_WATERMARKS, [
        { node_id: "peer", max_updated_at: serializeHLC(hlc) },
      ]);
    setDbFactory(db);
    const res = await exchange({ watermarks: {}, limit: 1e9 });
    expect(res.statusCode).toBe(200);

    const scans = db.calls(RECORDS_SELECT);
    expect(scans.length).toBeGreaterThan(0);
    for (const scan of scans) {
      // The scan asks for `limit + 1` — the extra row is how the responder
      // tells "that was everything" from "there is more".
      for (const value of scan.values) {
        if (typeof value === "number") expect(value).toBeLessThanOrEqual(1001);
      }
    }
  });

  it("serves a digest request, and says what width it used", async () => {
    // `verify()`'s half of the protocol, over the cloud handler rather than
    // the in-process transport it is otherwise only ever tested against. A
    // responder that answered without echoing the width would let two sides
    // compare buckets of different sizes and call it catastrophic divergence.
    emptyStore();
    const res = await exchange({
      watermarks: {},
      limit: 0,
      requestDigest: true,
      digestPrefixLength: 5,
    });
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toMatchObject({
      digest: [],
      digestPrefixLength: 5,
      digestScopes: ["shared"],
    });
  });

  it("ignores an unusable digest width instead of failing on it", async () => {
    // Dropped rather than refused: the requester compares the echoed width
    // against what it asked for and declines to compare on a mismatch, which
    // resolves this one layer up without an error.
    emptyStore();
    const res = await exchange({
      watermarks: {},
      limit: 0,
      requestDigest: true,
      digestPrefixLength: "wide",
    });
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)["digestPrefixLength"]).toBe(5);
  });

  it("does not include a digest when none was asked for", async () => {
    emptyStore();
    const res = await exchange({ watermarks: {} });
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)["digest"]).toBeUndefined();
  });
});

describe("/app-data routes", () => {
  const NS_SELECT = /from "shared"\."app_syncable_namespaces"/;
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
      .on(/insert into "app_appdata1"\."notes"/, []);
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
    const inserts = db.calls(/insert into "app_appdata1"\."notes"/);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.values.slice(0, 2)).toEqual(["n1", "hi"]); // + updated_at, deleted_at
  });

  it("queries live rows of a declared table", async () => {
    const db = fakeDsqlWithGrants()
      .on(NS_SELECT, [notesNamespace])
      .on(/select \* from "app_appdata1"\."notes" where "deleted_at" is null/, [
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
      .on(/update "app_appdata1"\."notes" set/, []);
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
    const updates = db.calls(/update "app_appdata1"\."notes" set/);
    expect(updates).toHaveLength(2);
    expect(updates[1]!.text).toMatch(/set "deleted_at"/);
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
  const FILE_RECORDS_SELECT = /select \* from "app_appdata1"\."_starkeep_sync_records"/;
  const FILE_RECORDS_INSERT = /insert into "app_appdata1"\."_starkeep_sync_records"/;
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
    // No checksum is pinned for an app-syncable key: the subKey is a stable
    // app-chosen name, not a hash, so there is nothing to derive from it.
    // Inventing one would reject every legitimate rewrite of such a file.
    expect(body["checksumSha256"]).toBeUndefined();
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

// ---- parentId / notLabel filters (media plan item 3) ----
//
// These exist to delete an O(library) scan: the resize path used to list every
// readable record and filter client-side, which was not only slow but *wrong*
// above the page limit — a record outside the first page read as "no thumbnail
// exists yet" and got one derived again.
describe("GET /data/records filters", () => {
  const grants = [{ type_id: "image/jpeg", access: "readwrite" }];

  it("pushes parentId into the query rather than filtering after it", async () => {
    const db = fakeDsqlWithGrants(grants).on(RECORDS_SELECT, [
      recordRow({ id: "child-1", type: "image/jpeg", parent_id: "parent-1" }),
    ]);
    setDbFactory(db);
    const res = await handler(
      signedEvent({
        appId: "app1",
        method: "GET",
        subPath: "/data/records",
        query: { parentId: "parent-1" },
      }),
      context,
    );
    expect(res.statusCode).toBe(200);
    const sql = db.calls(RECORDS_SELECT)[0]!;
    expect(sql.text).toContain('"parent_id" =');
    expect(sql.values).toContain("parent-1");
  });

  // "Originals only" for a grid. Expressed as a sentinel rather than an empty
  // value because `?parentId=` would be indistinguishable from a caller that
  // built the query string from an undefined variable.
  it("treats parentId=none as a null-parent filter", async () => {
    const db = fakeDsqlWithGrants(grants).on(RECORDS_SELECT, []);
    setDbFactory(db);
    await handler(
      signedEvent({
        appId: "app1",
        method: "GET",
        subPath: "/data/records",
        query: { parentId: "none" },
      }),
      context,
    );
    expect(db.calls(RECORDS_SELECT)[0]!.text).toContain('"parent_id" is null');
  });

  it("pushes notLabel into the query as a negated label filter", async () => {
    const db = fakeDsqlWithGrants(grants).on(RECORDS_SELECT, []);
    setDbFactory(db);
    const res = await handler(
      signedEvent({
        appId: "app1",
        method: "GET",
        subPath: "/data/records",
        query: { notLabel: "photos/rendition" },
      }),
      context,
    );
    expect(res.statusCode).toBe(200);
    const sql = db.calls(RECORDS_SELECT)[0]!;
    expect(sql.text).toContain("not exists");
    expect(sql.values).toContain("photos");
    expect(sql.values).toContain("rendition");
  });

  it("rejects a malformed notLabel rather than ignoring it", async () => {
    setDbFactory(fakeDsqlWithGrants(grants));
    const res = await handler(
      signedEvent({
        appId: "app1",
        method: "GET",
        subPath: "/data/records",
        query: { notLabel: "no-slash-here" },
      }),
      context,
    );
    // Silently ignoring it would return renditions mixed into the grid, which
    // looks like the filter working on a small library.
    expect(res.statusCode).toBe(400);
    expect(String(bodyOf(res)["error"])).toMatch(/notLabel/);
  });

  it("combines parentId with a label filter", async () => {
    const db = fakeDsqlWithGrants(grants)
      .on(/from "shared"\."record_labels" where "app_id" =/, [
        {
          record_id: "child-1",
          app_id: "photos",
          key: "thumbnail",
          value: "",
          record_type: "image/jpeg",
          created_at: serializeHLC({ wallTime: 1, counter: 0, nodeId: "n" }),
          updated_at: serializeHLC({ wallTime: 1, counter: 0, nodeId: "n" }),
          node_id: "n",
          deleted_at: null,
        },
      ])
      .on(RECORDS_SELECT, [
        recordRow({ id: "child-1", type: "image/jpeg", parent_id: "parent-1" }),
      ]);
    setDbFactory(db);
    const res = await handler(
      signedEvent({
        appId: "app1",
        method: "GET",
        subPath: "/data/records",
        query: { label: "photos/thumbnail", parentId: "parent-1" },
      }),
      context,
    );
    expect(res.statusCode).toBe(200);
    // The hydration query carries the parent constraint, so "a thumbnail *of
    // this record*" is one lookup rather than a label scan plus a client-side
    // parent check.
    const hydrate = db.calls(RECORDS_SELECT).at(-1)!;
    expect(hydrate.text).toContain('"parent_id" =');
    expect(hydrate.values).toContain("parent-1");
  });
});

// ---- The archive gate (media plan item 17) ----
//
// The property under test is the *split*: the app asserts its ladder is
// complete because only it knows what a complete ladder is, and the platform
// independently applies its own floors. Neither side alone can freeze anything,
// and each test below removes one side's contribution and checks nothing gets
// tagged.
describe("POST /data/records/:id/archive-gate", () => {
  const grants = [{ type_id: "image/jpeg", access: "readwrite" }];
  const bigKey = `shared/image/aa/${"a".repeat(64)}`;
  const TAGGING = /PutObjectTagging/;

  function dbWith(sizeBytes: number, labelRows: Array<Record<string, unknown>> = []) {
    return fakeDsqlWithGrants(grants)
      .on(RECORDS_SELECT, [
        recordRow({
          id: "rec-1",
          type: "image/jpeg",
          object_storage_key: bigKey,
          size_bytes: sizeBytes,
        }),
      ])
      .on(/from "shared"\."record_labels" where "record_id" in/, labelRows);
  }

  async function gate(body: Record<string, unknown>) {
    return handler(
      signedEvent({
        appId: "app1",
        method: "POST",
        subPath: "/data/records/rec-1/archive-gate",
        body,
      }),
      context,
    );
  }

  it("tags an object when the app asserts a complete ladder and the floors pass", async () => {
    setDbFactory(dbWith(50 * 1024 * 1024));
    s3Mock.on(PutObjectTaggingCommand).resolves({});
    const res = await gate({ ladderComplete: true });

    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)["tagged"]).toBe(true);
    const call = s3Mock.commandCalls(PutObjectTaggingCommand)[0]!;
    const tagSet = (call.args[0].input.Tagging as { TagSet: Array<{ Key: string; Value: string }> })
      .TagSet;
    const tags = Object.fromEntries(tagSet.map((t) => [t.Key, t.Value]));
    // Both tags, because the lifecycle rule requires both. Either alone would
    // either do nothing or freeze something it should not.
    expect(tags["starkeep:intent"]).toBe("archive");
    expect(tags["starkeep:ladder"]).toBe("complete");
  });

  // Tagged, not transitioned. The hold period is what buys a week to catch a
  // derivation bug before the input is behind a 48-hour thaw.
  it("does not itself transition anything", async () => {
    setDbFactory(dbWith(50 * 1024 * 1024));
    s3Mock.on(PutObjectTaggingCommand).resolves({});
    const res = await gate({ ladderComplete: true });
    expect(bodyOf(res)["archived"]).toBe(false);
  });

  // The app's half of the split removed.
  it("refuses when the app does not assert a complete ladder", async () => {
    setDbFactory(dbWith(50 * 1024 * 1024));
    s3Mock.on(PutObjectTaggingCommand).resolves({});
    const res = await gate({});
    expect(bodyOf(res)["tagged"]).toBeUndefined();
    expect(String((bodyOf(res)["refusals"] as string[])[0])).toMatch(/ladderComplete/);
    expect(s3Mock.commandCalls(PutObjectTaggingCommand)).toHaveLength(0);
  });

  // The platform's half. An app that is wrong about its ladder still cannot
  // archive a small file — which is the entire point of checking independently.
  it("refuses a small object even when the app says the ladder is complete", async () => {
    setDbFactory(dbWith(200 * 1024));
    s3Mock.on(PutObjectTaggingCommand).resolves({});
    const res = await gate({ ladderComplete: true });
    expect(bodyOf(res)["tagged"]).toBeUndefined();
    expect(String((bodyOf(res)["refusals"] as string[])[0])).toMatch(/floor/);
    expect(s3Mock.commandCalls(PutObjectTaggingCommand)).toHaveLength(0);
  });

  it("refuses a record marked starkeep/no-cloud", async () => {
    setDbFactory(
      dbWith(50 * 1024 * 1024, [
        {
          record_id: "rec-1",
          app_id: "starkeep",
          key: "no-cloud",
          value: "",
          record_type: "image/jpeg",
          created_at: serializeHLC({ wallTime: 1, counter: 0, nodeId: "n" }),
          updated_at: serializeHLC({ wallTime: 1, counter: 0, nodeId: "n" }),
          node_id: "n",
          deleted_at: null,
        },
      ]),
    );
    s3Mock.on(PutObjectTaggingCommand).resolves({});
    const res = await gate({ ladderComplete: true });
    expect(String((bodyOf(res)["refusals"] as string[]).join(" "))).toMatch(/no-cloud/);
    expect(s3Mock.commandCalls(PutObjectTaggingCommand)).toHaveLength(0);
  });

  // A read grant is not enough: this changes how the object is stored, and an
  // app that may only read has no business making it slow for everyone else.
  it("requires write access, not merely read", async () => {
    setDbFactory(
      fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "read" }]).on(RECORDS_SELECT, [
        recordRow({ id: "rec-1", type: "image/jpeg", object_storage_key: bigKey, size_bytes: 5e7 }),
      ]),
    );
    const res = await gate({ ladderComplete: true });
    expect(res.statusCode).toBe(403);
  });
});

// ---- Availability and restore (media plan item 5b) ----
//
// The guarantee under test: **a read never restores implicitly**. Without it, a
// future slideshow feature would thaw an entire archive one image at a time,
// each thaw costing money and twelve hours, with nothing in the call path
// looking wrong. Every case below is either "the caller is told before trying"
// or "the caller is refused rather than silently committed".
describe("availability and restore", () => {
  const grants = [{ type_id: "image/jpeg", access: "readwrite" }];
  const archivedKey = `shared/image/aa/${"a".repeat(64)}`;

  function archivedRow(over: Record<string, unknown> = {}) {
    return {
      object_storage_key: archivedKey,
      state: "archived",
      tier: "DEEP_ARCHIVE",
      expected_latency_hours: 12,
      ready_at_ms: null,
      restored_until_ms: null,
      observed_at_ms: 1,
      ...over,
    };
  }

  it("reports instant for an object nothing has moved", async () => {
    const db = fakeDsqlWithGrants(grants).on(RECORDS_SELECT, [
      recordRow({ id: "rec-1", type: "image/jpeg" }),
    ]);
    setDbFactory(db);
    const res = await handler(
      signedEvent({ appId: "app1", method: "GET", subPath: "/data/records" }),
      context,
    );
    const body = bodyOf(res) as { records: Array<Record<string, unknown>> };
    // Defaulting to instant is what makes staleness fail safe: a wrong answer
    // costs a recoverable 409 from the read path, where defaulting to archived
    // would make every record look unreadable until proven otherwise.
    expect(body.records[0]!["availability"]).toEqual({ state: "instant" });
  });

  it("reports archived, with the tier and the wait, on the listing itself", async () => {
    const db = fakeDsqlWithGrants(grants, [archivedRow()]).on(RECORDS_SELECT, [
      recordRow({ id: "rec-1", type: "image/jpeg", object_storage_key: archivedKey }),
    ]);
    setDbFactory(db);
    const res = await handler(
      signedEvent({ appId: "app1", method: "GET", subPath: "/data/records" }),
      context,
    );
    const body = bodyOf(res) as { records: Array<Record<string, unknown>> };
    // On the listing the client already fetched — so unreadability is known
    // before anything is attempted, rather than discovered as a stalled image.
    expect(body.records[0]!["availability"]).toEqual({
      state: "archived",
      tier: "DEEP_ARCHIVE",
      expectedLatencyHours: 12,
    });
  });

  it("refuses a file-url for archived bytes with 409, and does not restore", async () => {
    const db = fakeDsqlWithGrants(grants, [archivedRow()]).on(RECORDS_SELECT, [
      recordRow({ id: "rec-1", type: "image/jpeg", object_storage_key: archivedKey }),
    ]);
    setDbFactory(db);
    const res = await handler(
      signedEvent({ appId: "app1", method: "GET", subPath: "/data/records/rec-1/file-url" }),
      context,
    );
    expect(res.statusCode).toBe(409);
    const body = bodyOf(res);
    expect(body["error"]).toBe("ObjectArchived");
    expect(body["availability"]).toMatchObject({ tier: "DEEP_ARCHIVE" });
    // Nothing was written: a read must not have side effects, least of all
    // billable ones.
    expect(db.calls(/insert into "shared"\."object_availability"/)).toHaveLength(0);
  });

  it("409s a read of bytes already being restored rather than queueing another", async () => {
    const db = fakeDsqlWithGrants(grants, [
      archivedRow({ state: "restoring", ready_at_ms: 1_700_000_000_000 }),
    ]).on(RECORDS_SELECT, [
      recordRow({ id: "rec-1", type: "image/jpeg", object_storage_key: archivedKey }),
    ]);
    setDbFactory(db);
    const res = await handler(
      signedEvent({ appId: "app1", method: "GET", subPath: "/data/records/rec-1/file-url" }),
      context,
    );
    expect(res.statusCode).toBe(409);
    expect(bodyOf(res)["error"]).toBe("ObjectRestoring");
  });

  describe("POST /data/records/:id/restore", () => {
    function archivedDb() {
      return fakeDsqlWithGrants(grants, [archivedRow()]).on(RECORDS_SELECT, [
        recordRow({
          id: "rec-1",
          type: "image/jpeg",
          object_storage_key: archivedKey,
          size_bytes: 5 * 1024 ** 3,
        }),
      ]);
    }

    // The cost and the wait are invisible at the moment someone clicks.
    // Returning them as a distinct step is what makes them a decision rather
    // than a discovery.
    it("returns an estimate and does nothing without confirmation", async () => {
      const db = archivedDb();
      setDbFactory(db);
      const res = await handler(
        signedEvent({ appId: "app1", method: "POST", subPath: "/data/records/rec-1/restore", body: {} }),
        context,
      );
      expect(res.statusCode).toBe(200);
      const body = bodyOf(res);
      expect(body["confirmRequired"]).toBe(true);
      const estimate = body["estimate"] as Record<string, unknown>;
      expect(estimate["tier"]).toBe("Standard");
      expect(estimate["estimatedHours"]).toBe(12);
      expect(Number(estimate["estimatedCostUsd"])).toBeGreaterThan(0);
      expect(db.calls(/insert into "shared"\."object_availability"/)).toHaveLength(0);
    });

    it("issues the restore only on explicit confirmation", async () => {
      const db = archivedDb();
      setDbFactory(db);
      s3Mock.on(RestoreObjectCommand).resolves({});
      const res = await handler(
        signedEvent({
          appId: "app1",
          method: "POST",
          subPath: "/data/records/rec-1/restore",
          body: { confirm: true },
        }),
        context,
      );
      expect(res.statusCode).toBe(200);
      expect(bodyOf(res)["restoring"]).toBe(true);
      expect(db.calls(/insert into "shared"\."object_availability"/)).toHaveLength(1);
    });

    // The gap this closes: the endpoint used to record `restoring` and thaw
    // nothing, which is worse than not having it — it reports progress on a
    // restore nobody started, and the object never becomes readable.
    it("actually asks S3 to thaw the object", async () => {
      setDbFactory(archivedDb());
      s3Mock.on(RestoreObjectCommand).resolves({});
      await handler(
        signedEvent({
          appId: "app1",
          method: "POST",
          subPath: "/data/records/rec-1/restore",
          body: { confirm: true },
        }),
        context,
      );
      const calls = s3Mock.commandCalls(RestoreObjectCommand);
      expect(calls, "no RestoreObject was issued").toHaveLength(1);
      const input = calls[0]!.args[0].input as {
        RestoreRequest?: { Days?: number; GlacierJobParameters?: { Tier?: string } };
      };
      expect(input.RestoreRequest?.GlacierJobParameters?.Tier).toBe("Standard");
      // The thawed copy is held long enough that a print session or an export
      // does not re-thaw the same object; the charge is per restore.
      expect(input.RestoreRequest?.Days).toBeGreaterThan(1);
    });

    it("does not ask S3 to thaw anything when only an estimate was requested", async () => {
      setDbFactory(archivedDb());
      s3Mock.on(RestoreObjectCommand).resolves({});
      await handler(
        signedEvent({
          appId: "app1",
          method: "POST",
          subPath: "/data/records/rec-1/restore",
          body: {},
        }),
        context,
      );
      expect(s3Mock.commandCalls(RestoreObjectCommand)).toHaveLength(0);
    });

    // Standard rather than Bulk by default: the difference is hundredths of a
    // cent and thirty-six hours.
    it("defaults to the fast tier and lets a caller opt into the cheap one", async () => {
      setDbFactory(archivedDb());
      const bulk = await handler(
        signedEvent({
          appId: "app1",
          method: "POST",
          subPath: "/data/records/rec-1/restore",
          body: { tier: "Bulk" },
        }),
        context,
      );
      const estimate = bodyOf(bulk)["estimate"] as Record<string, unknown>;
      expect(estimate["tier"]).toBe("Bulk");
      expect(estimate["estimatedHours"]).toBe(48);
    });

    // Two clients racing on one archived record is ordinary, not an error.
    it("reports an already-readable record without restoring it", async () => {
      const db = fakeDsqlWithGrants(grants).on(RECORDS_SELECT, [
        recordRow({ id: "rec-1", type: "image/jpeg", object_storage_key: archivedKey }),
      ]);
      setDbFactory(db);
      const res = await handler(
        signedEvent({
          appId: "app1",
          method: "POST",
          subPath: "/data/records/rec-1/restore",
          body: { confirm: true },
        }),
        context,
      );
      expect(res.statusCode).toBe(200);
      expect(bodyOf(res)["alreadyReadable"]).toBe(true);
      expect(db.calls(/insert into "shared"\."object_availability"/)).toHaveLength(0);
    });

    it("does not queue a second restore for bytes already thawing", async () => {
      const db = fakeDsqlWithGrants(grants, [archivedRow({ state: "restoring" })]).on(
        RECORDS_SELECT,
        [recordRow({ id: "rec-1", type: "image/jpeg", object_storage_key: archivedKey })],
      );
      setDbFactory(db);
      const res = await handler(
        signedEvent({
          appId: "app1",
          method: "POST",
          subPath: "/data/records/rec-1/restore",
          body: { confirm: true },
        }),
        context,
      );
      expect(bodyOf(res)["alreadyRestoring"]).toBe(true);
      expect(db.calls(/insert into "shared"\."object_availability"/)).toHaveLength(0);
    });

    // A read grant is enough to *ask*. Requiring write access would leave a
    // read-only app able to see that a record is archived and unable to act.
    it("403s a caller with no read grant on the type", async () => {
      setDbFactory(
        fakeDsqlWithGrants([{ type_id: "audio/mp3", access: "read" }], [archivedRow()]).on(
          RECORDS_SELECT,
          [recordRow({ id: "rec-1", type: "image/jpeg", object_storage_key: archivedKey })],
        ),
      );
      const res = await handler(
        signedEvent({
          appId: "app1",
          method: "POST",
          subPath: "/data/records/rec-1/restore",
          body: { confirm: true },
        }),
        context,
      );
      expect(res.statusCode).toBe(403);
    });
  });
});

// ---- Sync blob downloads go through CloudFront (media plan item 4) ----
//
// The signing chokepoint itself is covered in cloudfront-signing.test.ts. What
// is covered here is that the route the *sync engine* uses actually reaches it:
// HttpObjectStorageAdapter.getStream asks GET /files/{key}/presign, and if that
// handed back an S3 presigned URL the sync path would quietly keep paying
// origin egress with no edge caching, and nothing would look wrong.
describe("GET /files/{key}/presign — the sync download path", () => {
  const sharedImageKey = `shared/image/aa/${"a".repeat(64)}`;

  it("signs shared bytes through CloudFront, not S3", async () => {
    setDbFactory(fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "read" }]));
    s3Mock.on(HeadObjectCommand).resolves({});
    const res = await handler(
      signedEvent({
        appId: "app1",
        method: "GET",
        subPath: `/files/${sharedImageKey}/presign`,
      }),
      context,
    );
    expect(res.statusCode).toBe(200);
    const url = String(bodyOf(res)["url"]);
    expect(url).toContain(CF_DOMAIN);
    expect(url).toContain("Signature=");
    // Not an S3 presigned URL — those carry SigV4 query parameters.
    expect(url).not.toContain("X-Amz-Signature");
  });

  // CloudFront never serves apps/*, so app-syncable bytes must stay on S3
  // presign. Routing them through the distribution would need a second origin
  // and a second grant model for no benefit — they are not shared data.
  it("leaves app-syncable bytes on S3 presign", async () => {
    setDbFactory(
      fakeDsqlWithGrants().on(/from "shared"\."app_syncable_namespaces"/, [
        {
          app_id: "app1",
          tables_json: JSON.stringify([{ name: "_starkeep_sync_records", pkColumns: ["id"] }]),
          files_enabled: true,
        },
      ]),
    );
    s3Mock.on(HeadObjectCommand).resolves({});
    const res = await handler(
      signedEvent({
        appId: "app1",
        method: "GET",
        subPath: "/files/apps/app1/syncable/cover/presign",
      }),
      context,
    );
    expect(res.statusCode).toBe(200);
    const url = String(bodyOf(res)["url"]);
    expect(url).toContain("X-Amz-Signature");
    expect(url).not.toContain(CF_DOMAIN);
  });

  it("404s a key with no object behind it", async () => {
    setDbFactory(fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "read" }]));
    s3Mock.on(HeadObjectCommand).rejects({ name: "NotFound", $metadata: { httpStatusCode: 404 } });
    const res = await handler(
      signedEvent({
        appId: "app1",
        method: "GET",
        subPath: `/files/${sharedImageKey}/presign`,
      }),
      context,
    );
    expect(res.statusCode).toBe(404);
  });
});

// ---- Variant resolution by target long edge (media plan item 3b) ----
//
// The resolution rules are tested in protocol-primitives and the gathering in
// storage-sqlite. What is tested here is the *contract at the edge*: a request
// that is malformed must be refused rather than answered as though it were
// valid, because a caller that asked in pixels precisely so it would not have
// to reason about size classes has no way to notice a silently-empty answer.
describe("GET /data/records variant resolution", () => {
  const grants = [{ type_id: "image/jpeg", access: "readwrite" }];

  async function request(query: Record<string, string>) {
    setDbFactory(fakeDsqlWithGrants(grants).on(RECORDS_SELECT, []));
    return handler(
      signedEvent({ appId: "app1", method: "GET", subPath: "/data/records", query }),
      context,
    );
  }

  it("accepts a variant label and a list of pixel sizes", async () => {
    const res = await request({ variant: "photos/rendition", variantLongEdge: "400,1280" });
    expect(res.statusCode).toBe(200);
  });

  // Either parameter alone is meaningless. Answering it as though it were
  // valid returns no variants, which reads as "this record has none" rather
  // than "you asked wrongly".
  it("rejects variant without variantLongEdge", async () => {
    const res = await request({ variant: "photos/rendition" });
    expect(res.statusCode).toBe(400);
    expect(String(bodyOf(res)["error"])).toMatch(/must be given together/);
  });

  it("rejects variantLongEdge without variant", async () => {
    const res = await request({ variantLongEdge: "400" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a malformed variant label", async () => {
    const res = await request({ variant: "no-slash", variantLongEdge: "400" });
    expect(res.statusCode).toBe(400);
    expect(String(bodyOf(res)["error"])).toMatch(/variant must be of the form/);
  });

  // "400px" is what you get from string-concatenating a CSS value, and
  // parseInt would happily accept it.
  it("rejects sizes that are not whole pixel counts", async () => {
    for (const bad of ["400px", "12abc", "400.5", "-400", "0"]) {
      const res = await request({ variant: "photos/rendition", variantLongEdge: bad });
      expect(res.statusCode, bad).toBe(400);
    }
  });

  it("caps how many sizes one request may ask for", async () => {
    const res = await request({
      variant: "photos/rendition",
      variantLongEdge: "100,200,300,400,500",
    });
    expect(res.statusCode).toBe(400);
    expect(String(bodyOf(res)["error"])).toMatch(/at most/);
  });

  // Omitting the parameters entirely must not start resolving variants — the
  // extra child query is not free, and every existing caller passes neither.
  it("does no variant work when neither parameter is present", async () => {
    const db = fakeDsqlWithGrants(grants).on(RECORDS_SELECT, [
      recordRow({ id: "rec-1", type: "image/jpeg" }),
    ]);
    setDbFactory(db);
    const res = await handler(
      signedEvent({ appId: "app1", method: "GET", subPath: "/data/records" }),
      context,
    );
    expect(res.statusCode).toBe(200);
    const body = bodyOf(res) as { records: Array<Record<string, unknown>> };
    expect(body.records[0]!["variants"]).toBeUndefined();
    // One records query, not two: no child lookup happened.
    expect(db.calls(RECORDS_SELECT)).toHaveLength(1);
  });
});

// ---- Verified uploads: the checksum pinned into the presigned PUT ----
//
// The property under test is that the broker decides what may be written at a
// content-addressed key, and the uploader has no say in it. Everything else
// here follows from that.
describe("POST /files/presign pins the expected checksum", () => {
  const hash = "b".repeat(64);
  const sharedKey = `shared/image/bb/${hash}`;
  const expectedChecksum = Buffer.from(hash, "hex").toString("base64");

  // Every presign first asks whether a live record at this key is marked
  // no-cloud. Stubbed empty here: the ordinary case is that the bytes are
  // uploaded before the record is registered, so there is nothing at the key
  // yet. (Registered per test rather than in `fakeDsqlWithGrants`, because
  // routes match in registration order and a shared default would shadow the
  // refusal test's own stub.)
  const noRecordAtKey = /from "shared"\."records" where "object_storage_key" =/;

  it("derives the checksum from the content-addressed key and returns it", async () => {
    setDbFactory(
      fakeDsqlWithGrants([{ type_id: "image", access: "readwrite" }]).on(noRecordAtKey, []),
    );
    const res = await handler(
      signedEvent({
        appId: "app1",
        method: "POST",
        subPath: "/files/presign",
        body: { key: sharedKey, contentType: "image/jpeg" },
      }),
      context,
    );
    expect(res.statusCode).toBe(200);
    const body = bodyOf(res);
    expect(body["checksumSha256"]).toBe(expectedChecksum);
    // Signed into the URL, not merely advertised beside it — otherwise an
    // uploader could drop the header and write whatever it liked.
    expect(String(body["url"])).toContain("x-amz-checksum-sha256");
  });

  // The caller never supplies the checksum, so it cannot lie about it. A body
  // field is ignored rather than honoured: honouring it would reduce the
  // guarantee to "the uploader verified its own bytes", which is no guarantee.
  // The residency decision on the cloud node elides a no-cloud record's blob,
  // but a fetch-time decision cannot stop an inbound *push*. Without this
  // refusal any node could upload the bytes and the constraint would be
  // advisory — a guarantee only one side of a transfer enforces is not one.
  it("refuses to presign a write for a record marked starkeep/no-cloud", async () => {
    const db = fakeDsqlWithGrants([{ type_id: "image", access: "readwrite" }])
      .on(noRecordAtKey, [
        recordRow({ id: "rec-nc", type: "image/jpeg", object_storage_key: sharedKey }),
      ])
      .on(/from "shared"\."record_labels" where "record_id" in/, [
        {
          record_id: "rec-nc",
          app_id: "starkeep",
          key: "no-cloud",
          value: "",
          record_type: "image/jpeg",
          created_at: serializeHLC({ wallTime: 1, counter: 0, nodeId: "n" }),
          updated_at: serializeHLC({ wallTime: 1, counter: 0, nodeId: "n" }),
          node_id: "n",
          deleted_at: null,
        },
      ]);
    setDbFactory(db);
    const res = await handler(
      signedEvent({
        appId: "app1",
        method: "POST",
        subPath: "/files/presign",
        body: { key: sharedKey },
      }),
      context,
    );
    expect(res.statusCode).toBe(403);
    expect(String(bodyOf(res)["error"])).toMatch(/no-cloud/);
  });

  // ---- Declared retrieval intent (media plan items 5 / 5b) ----
  //
  // The app declares latency it can tolerate; the broker decides the storage
  // class and tags, and binds both into the signature. Every assertion below
  // is about the broker deciding rather than the uploader.
  describe("declared retrieval intent", () => {
    it("defaults to instant when the caller says nothing", async () => {
      setDbFactory(
        fakeDsqlWithGrants([{ type_id: "image", access: "readwrite" }]).on(noRecordAtKey, []),
      );
      const res = await handler(
        signedEvent({
          appId: "app1",
          method: "POST",
          subPath: "/files/presign",
          body: { key: sharedKey },
        }),
        context,
      );
      // A write that forgot to think about retrieval must not produce something
      // that takes twelve hours to read.
      expect(bodyOf(res)["intent"]).toBe("instant");
      expect(bodyOf(res)["tagging"]).toBeUndefined();
    });

    it("tags an archive-intent write so a lifecycle rule can find it later", async () => {
      setDbFactory(
        fakeDsqlWithGrants([{ type_id: "image", access: "readwrite" }]).on(noRecordAtKey, []),
      );
      const res = await handler(
        signedEvent({
          appId: "app1",
          method: "POST",
          subPath: "/files/presign",
          body: { key: sharedKey, intent: "archive" },
        }),
        context,
      );
      expect(bodyOf(res)["intent"]).toBe("archive");
      expect(bodyOf(res)["tagging"]).toEqual({ "starkeep:intent": "archive" });
    });

    // Both tiers land in Intelligent-Tiering. `archive` is *not* written
    // straight to Deep Archive, because the transition is gated on the record's
    // ladder being complete and on a hold period — neither known at write time.
    // Freezing on write would freeze originals whose ladder does not exist yet,
    // which is exactly when the original is the only readable copy.
    it("writes both intents to Intelligent-Tiering, gating the freeze elsewhere", async () => {
      for (const intent of ["instant", "archive"]) {
        setDbFactory(
          fakeDsqlWithGrants([{ type_id: "image", access: "readwrite" }]).on(noRecordAtKey, []),
        );
        const res = await handler(
          signedEvent({
            appId: "app1",
            method: "POST",
            subPath: "/files/presign",
            body: { key: sharedKey, intent },
          }),
          context,
        );
        expect(bodyOf(res)["storageClass"], intent).toBe("INTELLIGENT_TIERING");
      }
    });

    it("binds the storage class and tags into the signature", async () => {
      setDbFactory(
        fakeDsqlWithGrants([{ type_id: "image", access: "readwrite" }]).on(noRecordAtKey, []),
      );
      const res = await handler(
        signedEvent({
          appId: "app1",
          method: "POST",
          subPath: "/files/presign",
          body: { key: sharedKey, intent: "archive" },
        }),
        context,
      );
      const url = String(bodyOf(res)["url"]);
      // Signed, not merely advertised: an unsigned header is one the uploader
      // can drop, which would let it choose its own tier and tag its way into
      // (or out of) a lifecycle rule it was never granted.
      expect(url).toContain("x-amz-storage-class");
      expect(url).toContain("x-amz-tagging");
    });

    // Defaulting a typo would be silently wrong in both directions: "instant"
    // costs money quietly, "archive" puts bytes behind a 48-hour thaw nobody
    // asked for. Neither announces itself.
    it("refuses an unrecognized intent rather than defaulting", async () => {
      setDbFactory(
        fakeDsqlWithGrants([{ type_id: "image", access: "readwrite" }]).on(noRecordAtKey, []),
      );
      const res = await handler(
        signedEvent({
          appId: "app1",
          method: "POST",
          subPath: "/files/presign",
          body: { key: sharedKey, intent: "archve" },
        }),
        context,
      );
      expect(res.statusCode).toBe(400);
      expect(String(bodyOf(res)["error"])).toMatch(/intent must be one of/);
    });
  });

  it("ignores a caller-supplied checksum in favour of the key's", async () => {
    setDbFactory(
      fakeDsqlWithGrants([{ type_id: "image", access: "readwrite" }]).on(noRecordAtKey, []),
    );
    const res = await handler(
      signedEvent({
        appId: "app1",
        method: "POST",
        subPath: "/files/presign",
        body: { key: sharedKey, checksumSha256: Buffer.from("f".repeat(64), "hex").toString("base64") },
      }),
      context,
    );
    expect(bodyOf(res)["checksumSha256"]).toBe(expectedChecksum);
  });

});
