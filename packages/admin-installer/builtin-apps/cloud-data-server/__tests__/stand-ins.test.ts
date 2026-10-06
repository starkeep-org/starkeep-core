/**
 * The cloud's stand-in routes, against the exported handler with DSQL scripted.
 *
 * The rules are the shared planner's and are tested there and in the local
 * data server's tier-1 suite. What this pins is the cloud's wiring: the planner
 * runs, its refusals reach the response unchanged, the original's fidelity is
 * written before the stand-in, and a slot conflict at the index becomes the
 * same 409 the planner gives.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { S3Client, HeadObjectCommand, PutObjectTaggingCommand } from "@aws-sdk/client-s3";
import { SETTINGS_TYPE_ID, serializeHLC } from "@starkeep/protocol-primitives";
import { signRequest } from "@starkeep/app-client";
import type { APIGatewayEvent, LambdaContext } from "../src/handler-utils.js";
import {
  CHILDREN_OF,
  STAND_INS_OF_PAGE,
  fakeDsqlWithGrants,
  recordRow,
  type FakeDsql,
  type LoggedQuery,
} from "./fake-dsql.js";
import { installUserTokenFixture } from "./user-token.js";

const ssmMock = mockClient(SSMClient);
const stsMock = mockClient(STSClient);
const s3Mock = mockClient(S3Client);

const context: LambdaContext = {
  invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:teststack-cds",
};

// A real key, so summary URLs are signed rather than refused.
const cfKeyPair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
const CF_SIGNING_PARAM = "/teststack/app-creds/_cloudfront-signing";

type HandlerModule = typeof import("../src/api-handler.js");
let handler: HandlerModule["handler"];
let setDbFactory: HandlerModule["__setDatabaseClientFactoryForTests"];
let userToken = "";

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
  ({ token: userToken } = await installUserTokenFixture());
});

afterAll(() => {
  setDbFactory(null);
});

beforeEach(() => {
  ssmMock.reset();
  stsMock.reset();
  s3Mock.reset();
  ssmMock.on(GetParameterCommand).callsFake(async (input: { Name?: string }) => {
    if (input.Name === CF_SIGNING_PARAM) {
      return {
        Parameter: {
          Value: JSON.stringify({
            keyPairId: "K2TESTKEYPAIRID",
            domain: "d1234testcdn.cloudfront.net",
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
  s3Mock.on(HeadObjectCommand).resolves({});
});

function request(appId: string, method: string, subPath: string, query?: Record<string, string>): APIGatewayEvent {
  const headers = signRequest({ appId, hmacSecret: `secret-${appId}`, method, path: subPath });
  return {
    rawPath: `/apps/${appId}${subPath}`,
    requestContext: { http: { method } },
    headers: { ...headers, "X-Starkeep-User-Token": userToken },
    ...(query ? { queryStringParameters: query } : {}),
  };
}

function post(appId: string, body: unknown): APIGatewayEvent {
  const bodyStr = JSON.stringify(body);
  const headers = signRequest({
    appId,
    hmacSecret: `secret-${appId}`,
    method: "POST",
    path: "/data/records",
    body: bodyStr,
  });
  return {
    rawPath: `/apps/${appId}/data/records`,
    requestContext: { http: { method: "POST" } },
    headers: { ...headers, "X-Starkeep-User-Token": userToken },
    body: bodyStr,
  };
}

const GRANTS = [
  { type_id: "image/jpeg", access: "readwrite" },
  { type_id: "image/avif", access: "readwrite" },
];
const PARENT_ID = "01PARENT000000000000000000";
const HASH = "c".repeat(64);
const RECORDS_INSERT = /insert into "shared"\."records"/;
const GET_BY_ID = /from "shared"\."records" where "id" = \$1/;
const LIVE_STAND_IN = /from "shared"\."records" where "parent_id" = \$1 and "stand_in_role" = \$2/;
/** A serialized deletion reading, for a row that has to read as tombstoned. */
const TOMBSTONE_HLC = serializeHLC({ wallTime: Date.UTC(2026, 9, 1), counter: 0, nodeId: "cloud" });

function parentRow(over: Record<string, unknown> = {}) {
  return recordRow({
    id: PARENT_ID,
    type: "image/jpeg",
    size_bytes: 8 * 1024 * 1024,
    fidelity: 6000,
    // Stamped with the default, as the cloud stamps every original it applies.
    // An unstamped original is `awaiting-stamp` and takes no stand-in, so the
    // cases about that state pass `canonical_threshold: null` themselves.
    canonical_threshold: 4272,
    ...over,
  });
}

function standInBody(over: Record<string, unknown> = {}) {
  return {
    type: "image/avif",
    contentType: "image/avif",
    contentHash: HASH,
    sizeBytes: 3000,
    fileName: "image-thumb_cat.jpg",
    parentId: PARENT_ID,
    standIn: { role: "smaller", fidelity: 640 },
    ...over,
  };
}

/** The column values of an insert, keyed by column name. */
function inserted(q: LoggedQuery): Record<string, unknown> {
  const columns = /insert into "shared"\."records" \(([^)]*)\)/.exec(q.text)![1]!
    .split(",")
    .map((c) => c.trim().replace(/"/g, ""));
  return Object.fromEntries(columns.map((c, i) => [c, q.values[i]]));
}

describe("POST /data/records with a stand-in", () => {
  it("creates a smaller stand-in with its role, fidelity and slot", async () => {
    const db = fakeDsqlWithGrants(GRANTS)
      .on(GET_BY_ID, [parentRow()])
      .on(LIVE_STAND_IN, [])
      .on(RECORDS_INSERT, []);
    setDbFactory(db);
    const res = await handler(post("si1", standInBody()), context);
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).record).toMatchObject({ stand_in_role: "smaller", fidelity: 640 });
    const inserts = db.calls(RECORDS_INSERT).map(inserted);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      stand_in_role: "smaller",
      fidelity: 640,
      stand_in_slot: "640",
      parent_id: PARENT_ID,
    });
  });

  it("records the original's fidelity before the stand-in", async () => {
    const db = fakeDsqlWithGrants(GRANTS)
      .on(GET_BY_ID, [parentRow({ fidelity: null, origin_app_id: "drive" })])
      .on(LIVE_STAND_IN, [])
      .on(RECORDS_INSERT, []);
    setDbFactory(db);
    const res = await handler(post("si2", standInBody({ parentFidelity: 5000 })), context);
    expect(res.statusCode).toBe(201);
    const inserts = db.calls(RECORDS_INSERT).map(inserted);
    expect(inserts.map((i) => i.id)).toEqual([PARENT_ID, expect.any(String)]);
    expect(inserts[0]).toMatchObject({ fidelity: 5000, origin_app_id: "drive", version: 2, stand_in_slot: null });
    expect(inserts[1]).toMatchObject({ stand_in_role: "smaller" });
  });

  it("returns the planner's refusal unchanged, writing nothing", async () => {
    const db = fakeDsqlWithGrants(GRANTS).on(GET_BY_ID, [parentRow()]).on(LIVE_STAND_IN, []);
    setDbFactory(db);
    const res = await handler(post("si3", standInBody({ standIn: { role: "smaller", fidelity: 500 } })), context);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: "InvalidStandIn", code: "not-a-standard-size" });
    expect(db.calls(RECORDS_INSERT)).toHaveLength(0);
  });

  it("answers 409 naming the stand-in that holds the slot", async () => {
    const db = fakeDsqlWithGrants(GRANTS)
      .on(GET_BY_ID, [parentRow()])
      .on(LIVE_STAND_IN, (q) =>
        q.values.includes("smaller")
          ? [
              recordRow({
                id: "01OCCUPANT0000000000000000",
                type: "image/avif",
                parent_id: PARENT_ID,
                stand_in_role: "smaller",
                fidelity: 640,
              }),
            ]
          : [],
      );
    setDbFactory(db);
    const res = await handler(post("si4", standInBody()), context);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: "StandInExists", existing: "01OCCUPANT0000000000000000" });
    expect(db.calls(RECORDS_INSERT)).toHaveLength(0);
  });

  it("turns a slot conflict at the index into the same 409", async () => {
    let raced = false;
    const db = fakeDsqlWithGrants(GRANTS)
      .on(GET_BY_ID, [parentRow()])
      .on(LIVE_STAND_IN, () =>
        raced
          ? [
              recordRow({
                id: "01WINNER000000000000000000",
                type: "image/avif",
                parent_id: PARENT_ID,
                stand_in_role: "smaller",
                fidelity: 640,
              }),
            ]
          : [],
      )
      .on(RECORDS_INSERT, () => {
        raced = true;
        throw new Error('duplicate key value violates unique constraint "uq_records_stand_in_slot"');
      });
    setDbFactory(db);
    const res = await handler(post("si5", standInBody()), context);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: "StandInExists", existing: "01WINNER000000000000000000" });
  });

  it("stores an original's own fidelity", async () => {
    const db = fakeDsqlWithGrants(GRANTS).on(RECORDS_INSERT, []);
    setDbFactory(db);
    const res = await handler(
      post("si6", { type: "image/jpeg", contentType: "image/jpeg", contentHash: HASH, sizeBytes: 3, fidelity: 4000 }),
      context,
    );
    expect(res.statusCode).toBe(201);
    expect(inserted(db.calls(RECORDS_INSERT)[0]!)).toMatchObject({ fidelity: 4000, stand_in_role: null });
  });

  it("refuses a fidelity on a record outside the stand-in categories", async () => {
    setDbFactory(fakeDsqlWithGrants([{ type_id: "document/pdf", access: "readwrite" }]));
    const res = await handler(
      post("si7", { type: "document/pdf", contentType: "application/pdf", contentHash: HASH, sizeBytes: 3, fidelity: 4 }),
      context,
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("fidelity-outside-stand-in-category");
  });
});

const SMALL_ID = "01SMALL0000000000000000000";
const CANONICAL_ID = "01CANONICAL000000000000000";
function smallRow() {
  return recordRow({
    id: SMALL_ID,
    type: "image/avif",
    parent_id: PARENT_ID,
    stand_in_role: "smaller",
    fidelity: 640,
    object_storage_key: `shared/image/dd/${"d".repeat(64)}`,
  });
}
function canonicalRow() {
  return recordRow({
    id: CANONICAL_ID,
    type: "image/avif",
    parent_id: PARENT_ID,
    stand_in_role: "canonical",
    fidelity: 4272,
    object_storage_key: `shared/image/ee/${"e".repeat(64)}`,
  });
}

describe("GET /data/records", () => {
  it("leaves stand-ins out of the page and describes them on their original", async () => {
    const db = fakeDsqlWithGrants(GRANTS)
      .on(STAND_INS_OF_PAGE, [smallRow(), canonicalRow()])
      .on(/select \* from "shared"\."records"/, [parentRow()]);
    setDbFactory(db);
    const res = await handler(request("ls1", "GET", "/data/records"), context);
    expect(res.statusCode).toBe(200);
    const page = db.calls(/select \* from "shared"\."records"/).find((q) => !STAND_INS_OF_PAGE.test(q.text))!;
    expect(page.text).toMatch(/"stand_in_role" is null/);
    const record = JSON.parse(res.body).records[0];
    expect(record.stand_ins.status).toBe("archivable");
    expect(record.stand_ins.sizes.map((s: { fidelity: number; placement: string }) => [s.fidelity, s.placement])).toEqual([
      [320, "missing"],
      [640, "cloud"],
      [1280, "missing"],
      [2560, "missing"],
      [4272, "cloud"],
    ]);
  });

  it("drops the collapse for include=stand-ins", async () => {
    const db = fakeDsqlWithGrants(GRANTS).on(/select \* from "shared"\."records"/, [smallRow()]);
    setDbFactory(db);
    const res = await handler(request("ls2", "GET", "/data/records", { include: "stand-ins" }), context);
    expect(res.statusCode).toBe(200);
    for (const q of db.calls(/select \* from "shared"\."records"/)) {
      expect(q.text).not.toMatch(/"stand_in_role" is null/);
    }
  });

  it("signs a URL on each existing size for include=stand-in-urls", async () => {
    const db = fakeDsqlWithGrants(GRANTS)
      .on(STAND_INS_OF_PAGE, [smallRow()])
      .on(/select \* from "shared"\."records"/, [parentRow()]);
    setDbFactory(db);
    const res = await handler(request("ls3", "GET", "/data/records", { include: "stand-in-urls" }), context);
    expect(res.statusCode).toBe(200);
    const sizes = JSON.parse(res.body).records[0].stand_ins.sizes as Array<{ fidelity: number; url?: string }>;
    // Existing sizes are signed against the platform distribution; missing
    // sizes have nothing to sign.
    expect(sizes.find((s) => s.fidelity === 640)!.url).toMatch(/^https:\/\/d1234testcdn\.cloudfront\.net\/shared\/image\//);
    expect(sizes.find((s) => s.fidelity === 320)!.url).toBeUndefined();
  });
});

describe("GET /data/records/:id/content-url", () => {
  it("refuses a size off the standard set", async () => {
    setDbFactory(fakeDsqlWithGrants(GRANTS).on(GET_BY_ID, [parentRow()]));
    const res = await handler(
      request("cu1", "GET", `/data/records/${PARENT_ID}/content-url`, { size: "500" }),
      context,
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("NotAStandardSize");
  });

  it("answers 404 with the summary for a size nobody produced", async () => {
    setDbFactory(fakeDsqlWithGrants(GRANTS).on(GET_BY_ID, [parentRow()]).on(STAND_INS_OF_PAGE, [smallRow()]));
    const res = await handler(
      request("cu2", "GET", `/data/records/${PARENT_ID}/content-url`, { size: "1280" }),
      context,
    );
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ error: "SizeNotProduced", fidelity: 1280 });
  });

  it("refuses to read a record the caller cannot read", async () => {
    setDbFactory(
      fakeDsqlWithGrants([{ type_id: "image/avif", access: "readwrite" }]).on(GET_BY_ID, [parentRow()]),
    );
    const res = await handler(
      request("cu3", "GET", `/data/records/${PARENT_ID}/content-url`, { size: "640" }),
      context,
    );
    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /data/records/:id", () => {
  it("tombstones the original's stand-ins and derived records with it", async () => {
    const db = fakeDsqlWithGrants(GRANTS)
      .on(CHILDREN_OF, [smallRow(), canonicalRow()])
      .on(GET_BY_ID, [parentRow()])
      .on(/update "shared"\."records" set "deleted_at"/, []);
    setDbFactory(db);
    const res = await handler(request("del1", "DELETE", `/data/records/${PARENT_ID}`), context);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ids).toEqual([SMALL_ID, CANONICAL_ID, PARENT_ID]);
    const tombstoned = db
      .calls(/update "shared"\."records" set "deleted_at"/)
      .map((q) => q.values[q.values.length - 1]);
    expect(tombstoned).toEqual([SMALL_ID, CANONICAL_ID, PARENT_ID]);
  });

  it("refuses the canonical stand-in alone while its original is live", async () => {
    const db = fakeDsqlWithGrants(GRANTS)
      .on(GET_BY_ID, (q) => (q.values.includes(CANONICAL_ID) ? [canonicalRow()] : [parentRow()]))
      .on(/update "shared"\."records" set "deleted_at"/, []);
    setDbFactory(db);
    const res = await handler(request("del2", "DELETE", `/data/records/${CANONICAL_ID}`), context);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe("CanonicalStandIn");
    expect(db.calls(/update "shared"\."records" set "deleted_at"/)).toHaveLength(0);
  });
});

describe("GET /data/records/:id/content-url, signed", () => {
  it("names the stand-in served and signs its URL", async () => {
    setDbFactory(
      fakeDsqlWithGrants(GRANTS)
        .on(GET_BY_ID, (q) => (q.values.includes(SMALL_ID) ? [smallRow()] : [parentRow()]))
        .on(STAND_INS_OF_PAGE, [smallRow()]),
    );
    const res = await handler(
      request("cu4", "GET", `/data/records/${PARENT_ID}/content-url`, { size: "640" }),
      context,
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      record_id: SMALL_ID,
      type: "image/avif",
      fidelity: 640,
      role: "smaller",
      url: expect.stringMatching(/^https:\/\/d1234testcdn\.cloudfront\.net\//),
    });
  });

  it("refuses to hand out an archived self-canonical original", async () => {
    const own = parentRow({ fidelity: 2000 });
    setDbFactory(
      fakeDsqlWithGrants(GRANTS, [
        {
          object_storage_key: own["object_storage_key"],
          state: "archived",
          tier: "DEEP_ARCHIVE",
          expected_latency_hours: 12,
          ready_at_ms: null,
          updated_at_ms: 0,
        },
      ]).on(GET_BY_ID, [own]),
    );
    const res = await handler(
      request("cu5", "GET", `/data/records/${PARENT_ID}/content-url`, { size: "canonical" }),
      context,
    );
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe("ObjectArchived");
  });
});

describe("the platform's archiving decision", () => {
  const SHARING = /from "shared"\."records" where "object_storage_key" = \$1 and "deleted_at" is null/;
  const LABELS_BY_IDS = /from "shared"\."record_labels" where "record_id" in/;
  const PARENT_KEY = parentRow()["object_storage_key"] as string;

  function tagsWritten(): Array<{ key: string; tags: Record<string, string> }> {
    return s3Mock.commandCalls(PutObjectTaggingCommand).map((call) => {
      const input = call.args[0].input;
      const tagSet = (input.Tagging as { TagSet: Array<{ Key: string; Value: string }> }).TagSet;
      return { key: input.Key!, tags: Object.fromEntries(tagSet.map((t) => [t.Key, t.Value])) };
    });
  }

  it("tags the original once its canonical stand-in lands", async () => {
    let inserted = false;
    const db = fakeDsqlWithGrants(GRANTS)
      .on(GET_BY_ID, [parentRow()])
      .on(LIVE_STAND_IN, () => (inserted ? [canonicalRow()] : []))
      .on(SHARING, [parentRow()])
      .on(LABELS_BY_IDS, [])
      .on(RECORDS_INSERT, () => {
        inserted = true;
        return [];
      });
    setDbFactory(db);
    s3Mock.on(PutObjectTaggingCommand).resolves({});
    const res = await handler(
      post("ar1", standInBody({ standIn: { role: "canonical", fidelity: 4272 } })),
      context,
    );
    expect(res.statusCode).toBe(201);
    expect(tagsWritten()).toEqual([
      { key: PARENT_KEY, tags: { "starkeep:intent": "archive", "starkeep:ladder": "complete" } },
    ]);
  });

  it("tags nothing for a smaller stand-in", async () => {
    setDbFactory(
      fakeDsqlWithGrants(GRANTS)
        .on(GET_BY_ID, [parentRow()])
        .on(LIVE_STAND_IN, [])
        .on(RECORDS_INSERT, []),
    );
    s3Mock.on(PutObjectTaggingCommand).resolves({});
    const res = await handler(post("ar2", standInBody()), context);
    expect(res.statusCode).toBe(201);
    expect(tagsWritten()).toEqual([]);
  });

  it("clears the tags when an app asks not to archive, even with only a read grant", async () => {
    const hlc = serializeHLC({ wallTime: Date.UTC(2026, 0, 1), counter: 0, nodeId: "test" });
    const db = fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "read" }])
      .on(/from "shared"\."app_label_keys"/, [])
      .on(/from "shared"\."records" where "id" in/, [parentRow()])
      .on(GET_BY_ID, [parentRow()])
      .on(SHARING, [parentRow()])
      .on(LIVE_STAND_IN, [canonicalRow()])
      .on(LABELS_BY_IDS, [
        {
          record_id: PARENT_ID,
          app_id: "viewer",
          key: "do-not-archive",
          value: "",
          record_type: "image/jpeg",
          created_at: hlc,
          updated_at: hlc,
          node_id: "test",
          deleted_at: null,
        },
      ])
      .on(/insert into "shared"\."record_labels"/, []);
    setDbFactory(db);
    s3Mock.on(PutObjectTaggingCommand).resolves({});
    const bodyStr = JSON.stringify({ labels: [{ recordId: PARENT_ID, key: "do-not-archive" }] });
    const res = await handler(
      {
        rawPath: "/apps/viewer/data/labels",
        requestContext: { http: { method: "POST" } },
        headers: {
          ...signRequest({
            appId: "viewer",
            hmacSecret: "secret-viewer",
            method: "POST",
            path: "/data/labels",
            body: bodyStr,
          }),
          "X-Starkeep-User-Token": userToken,
        },
        body: bodyStr,
      },
      context,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(tagsWritten()).toEqual([{ key: PARENT_KEY, tags: {} }]);
  });

  it("clears the tags when the original is deleted", async () => {
    // The transition is performed by a bucket lifecycle rule whose clock runs on
    // object age with no view of any record, so a tag left behind after a delete
    // fires on schedule and lands bytes nothing references in Deep Archive, owing a
    // 180-day minimum. Delete time is the only moment the platform still holds the
    // decision — and only the cloud holds the tags.
    let deleted = false;
    const db = fakeDsqlWithGrants(GRANTS)
      .on(CHILDREN_OF, [])
      .on(GET_BY_ID, () => [parentRow(deleted ? { deleted_at: TOMBSTONE_HLC } : {})])
      // After the delete, nothing live shares the object.
      .on(SHARING, () => (deleted ? [] : [parentRow()]))
      .on(LABELS_BY_IDS, [])
      .on(/update "shared"\."records" set "deleted_at"/, () => {
        deleted = true;
        return [];
      });
    setDbFactory(db);
    s3Mock.on(PutObjectTaggingCommand).resolves({});
    const res = await handler(request("delt", "DELETE", `/data/records/${PARENT_ID}`), context);
    expect(res.statusCode, res.body).toBe(200);
    expect(tagsWritten()).toEqual([{ key: PARENT_KEY, tags: {} }]);
  });

  it("leaves the tags alone when a live record still shares the object", async () => {
    // Object keys name bytes, so two records holding one file under two names share
    // an object. The tag is a fact about the object, not about either record.
    let deleted = false;
    const db = fakeDsqlWithGrants(GRANTS)
      .on(CHILDREN_OF, [])
      .on(GET_BY_ID, () => [parentRow(deleted ? { deleted_at: TOMBSTONE_HLC } : {})])
      .on(SHARING, [parentRow({ id: "01SIBLINGSIBLINGSIBLINGSB" })])
      .on(LABELS_BY_IDS, [])
      .on(/update "shared"\."records" set "deleted_at"/, () => {
        deleted = true;
        return [];
      });
    setDbFactory(db);
    s3Mock.on(PutObjectTaggingCommand).resolves({});
    const res = await handler(request("delt2", "DELETE", `/data/records/${PARENT_ID}`), context);
    expect(res.statusCode, res.body).toBe(200);
    expect(tagsWritten()).toEqual([]);
  });
});

describe("POST /data/records/:id/fidelity", () => {
  function report(appId: string, id: string, fidelity: unknown): APIGatewayEvent {
    const bodyStr = JSON.stringify({ fidelity });
    const path = `/data/records/${id}/fidelity`;
    return {
      rawPath: `/apps/${appId}${path}`,
      requestContext: { http: { method: "POST" } },
      headers: {
        ...signRequest({ appId, hmacSecret: `secret-${appId}`, method: "POST", path, body: bodyStr }),
        "X-Starkeep-User-Token": userToken,
      },
      body: bodyStr,
    };
  }

  it("writes the original's fidelity as a platform write", async () => {
    const db = fakeDsqlWithGrants(GRANTS)
      // Unmeasured and unstamped: the report records both, so the cloud reads
      // the library's settings to know what to stamp with.
      .on(GET_BY_ID, [parentRow({ fidelity: null, canonical_threshold: null, origin_app_id: "drive" })])
      .on(LIVE_STAND_IN, [])
      .on(/from "shared"\."records" where "object_storage_key" = \$1 and "deleted_at" is null/, [parentRow()])
      .on(/from "shared"\."record_labels" where "record_id" in/, [])
      .on(RECORDS_INSERT, []);
    setDbFactory(db);
    const res = await handler(report("fr1", PARENT_ID, 6000), context);
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      id: PARENT_ID,
      fidelity: 6000,
      canonical_threshold: 4272,
      recorded: true,
    });
    expect(inserted(db.calls(RECORDS_INSERT)[0]!)).toMatchObject({
      fidelity: 6000,
      canonical_threshold: 4272,
      origin_app_id: "drive",
    });
    // The stamp is read from the library's settings first.
    expect(db.log.some((q) => q.values.includes(SETTINGS_TYPE_ID))).toBe(true);
  });

  it("answers 409 for a disagreeing report", async () => {
    const db = fakeDsqlWithGrants(GRANTS).on(GET_BY_ID, [parentRow({ fidelity: 6000 })]);
    setDbFactory(db);
    const res = await handler(report("fr2", PARENT_ID, 5000), context);
    expect(res.statusCode).toBe(409);
    expect(db.log.some((q) => q.values.includes(SETTINGS_TYPE_ID))).toBe(false);
  });
});

/**
 * The cloud reads the library's settings from the database only for a request
 * that stamps an original. Each warm Lambda caches the value, and a settings
 * file another instance applied reaches this one only through the database,
 * so a request that stamps reads first; every other request skips the query.
 */
describe("reading the library's settings", () => {
  const SETTINGS_ID = "01SETTINGS0000000000000000";
  /** The settings lookup, recognised by the type it asks for. */
  const settingsReads = (db: FakeDsql) => db.log.filter((q) => q.values.includes(SETTINGS_TYPE_ID));
  const hlc = { wallTime: Date.UTC(2026, 0, 2), counter: 0, nodeId: "peer" };

  function exchange(body: unknown): APIGatewayEvent {
    const appId = "starkeep-drive";
    const bodyStr = JSON.stringify(body);
    const path = "/sync/exchange";
    return {
      rawPath: `/apps/${appId}${path}`,
      requestContext: { http: { method: "POST" } },
      headers: {
        ...signRequest({ appId, hmacSecret: `secret-${appId}`, method: "POST", path, body: bodyStr }),
        "X-Starkeep-User-Token": userToken,
      },
      body: bodyStr,
    };
  }

  /** An original as a peer ships it: a fidelity, and the stamp it knew. */
  function shippedOriginal(canonicalThreshold: number | null) {
    return {
      id: SETTINGS_ID.replace("SETTINGS", "ORIGINAL"),
      kind: "data",
      type: "image/jpeg",
      originAppId: "photos",
      createdAt: hlc,
      updatedAt: hlc,
      deletedAt: null,
      version: 1,
      contentHash: HASH,
      objectStorageKey: `shared/image/cc/${HASH}`,
      mimeType: "image/jpeg",
      sizeBytes: 8 * 1024 * 1024,
      originalFilename: null,
      parentId: null,
      standInRole: null,
      fidelity: 6000,
      canonicalThreshold,
    };
  }

  /** A store that answers every exchange query with nothing. */
  function emptyStore(): FakeDsql {
    const db = fakeDsqlWithGrants(GRANTS)
      .on(RECORDS_INSERT, [])
      .otherwise(/from "shared"\."records"/, [])
      .otherwise(/from "shared"\."record_\w+_metadata"/, []);
    setDbFactory(db);
    return db;
  }

  it("reads them before a Drive exchange applies an unstamped original", async () => {
    const db = emptyStore();
    const res = await handler(exchange({ watermarks: {}, records: [shippedOriginal(null)] }), context);
    expect(res.statusCode, res.body).toBe(200);
    expect(settingsReads(db)).toHaveLength(1);
    expect(db.log.indexOf(settingsReads(db)[0]!)).toBeLessThan(db.log.indexOf(db.calls(RECORDS_INSERT)[0]!));
  });

  it("skips them for a Drive exchange with nothing to stamp", async () => {
    for (const body of [{ watermarks: {} }, { watermarks: {}, records: [shippedOriginal(4272)] }]) {
      const db = emptyStore();
      const res = await handler(exchange(body), context);
      expect(res.statusCode, res.body).toBe(200);
      expect(settingsReads(db), JSON.stringify(body)).toHaveLength(0);
    }
  });

  it("reads them for a record write that stamps, and skips them otherwise", async () => {
    const stamping = emptyStore();
    await handler(
      post("rs1", { type: "image/jpeg", contentType: "image/jpeg", contentHash: HASH, sizeBytes: 3, fidelity: 4000 }),
      context,
    );
    expect(settingsReads(stamping)).toHaveLength(1);

    const plain = emptyStore();
    await handler(post("rs2", { type: "image/jpeg", contentType: "image/jpeg", contentHash: HASH, sizeBytes: 3 }), context);
    expect(settingsReads(plain)).toHaveLength(0);
  });

  it("skips them for a listing", async () => {
    const db = emptyStore();
    const res = await handler(request("rs3", "GET", "/data/records"), context);
    expect(res.statusCode, res.body).toBe(200);
    expect(settingsReads(db)).toHaveLength(0);
  });
});
