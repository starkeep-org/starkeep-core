/**
 * Cross-app record labels on the cloud-data-server, against the real handler
 * with DSQL replaced through the test seam.
 *
 * The SQL assertions here are doing real work: they pin that a label write
 * never touches `shared.records`, and that `app_id` is bound from the
 * authenticated subject rather than anything in the request body.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";
import { signRequest } from "@starkeep/app-client";
import { installUserTokenFixture } from "./user-token.js";
import { serializeHLC } from "@starkeep/protocol-primitives";
import type { APIGatewayEvent, LambdaContext } from "../src/handler-utils.js";
import { fakeDsqlWithGrants, recordRow, type FakeDsql } from "./fake-dsql.js";

const ssmMock = mockClient(SSMClient);
const stsMock = mockClient(STSClient);
const s3Mock = mockClient(S3Client);

const context: LambdaContext = {
  invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:teststack-cds",
};

type HandlerModule = typeof import("../src/api-handler.js");
let handler: HandlerModule["handler"];
let setDbFactory: HandlerModule["__setDatabaseClientFactoryForTests"];

beforeAll(async () => {
  process.env.STACK_PREFIX = "teststack";
  process.env.AURORA_ENDPOINT = "invalid.test.localdomain";
  process.env.S3_BUCKET = "fake-bucket";
  process.env.AWS_REGION = "us-east-1";
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
  ssmMock.on(GetParameterCommand).callsFake(async (input: { Name?: string }) => {
    const appId = input.Name!.split("/").pop()!;
    return { Parameter: { Value: JSON.stringify({ hmacSecret: `secret-${appId}` }) } };
  });
  stsMock.on(AssumeRoleCommand).resolves({
    Credentials: {
      AccessKeyId: "AKIA",
      SecretAccessKey: "secret",
      SessionToken: "token",
      Expiration: new Date(Date.now() + 3_600_000),
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

const TEST_HLC = serializeHLC({ wallTime: Date.UTC(2026, 0, 1), counter: 0, nodeId: "test" });

const RECORDS_SELECT = /select \* from "shared"\."records"/;
const RECORDS_INSERT = /insert into "shared"\."records"/;
const RECORDS_UPDATE = /update "shared"\."records"/;
const LABELS_INSERT = /insert into "shared"\."record_labels"/;
const LABELS_UPDATE = /update "shared"\."record_labels"/;
const LABELS_SELECT = /select \* from "shared"\."record_labels"/;
/**
 * The forward hydration shape — `?include=labels`, and now also the
 * value-cardinality cap's read of what the app already has stored. Narrow
 * enough not to shadow the reverse query, which orders by value.
 */
const LABELS_BY_IDS = /from "shared"\."record_labels" where "record_id" in/;
const LABEL_KEYS_SELECT = /from "shared"\."app_label_keys"/;

/** Read-only grant on image/jpeg, with two declared label keys. */
function annotatorDb(over?: {
  records?: Record<string, unknown>[];
  declaredKeys?: string[];
  storedLabels?: Record<string, unknown>[];
}): FakeDsql {
  return fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "read" }])
    .on(LABEL_KEYS_SELECT, (over?.declaredKeys ?? ["faces-detected", "face-count"]).map((key) => ({
      app_id: "annotator",
      key,
      description: `desc for ${key}`,
    })))
    .on(RECORDS_SELECT, over?.records ?? [recordRow({ id: "rec1", type: "image/jpeg" })])
    // The write path reads this app's stored values for the batch's records, so
    // the value cap counts rows already there and not just the ones in front of
    // it. Empty = nothing stored yet, which is what every test here assumes.
    .on(LABELS_BY_IDS, over?.storedLabels ?? [])
    .on(LABELS_INSERT, [])
    .on(LABELS_UPDATE, []);
}

describe("POST /data/labels", () => {
  it("writes a flag and a valued label with only a read grant", async () => {
    // The central authorization decision: labelling costs a read grant, not
    // readwrite. An OCR service must not need destructive power over photos.
    const db = annotatorDb();
    setDbFactory(db);
    const res = await handler(
      signedEvent({
        appId: "annotator",
        method: "POST",
        subPath: "/data/labels",
        body: {
          labels: [
            { recordId: "rec1", key: "faces-detected" },
            { recordId: "rec1", key: "face-count", value: "3" },
          ],
        },
      }),
      context,
    );
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ written: 2 });
  });

  it("binds app_id from the authenticated subject, not the request body", async () => {
    const db = annotatorDb();
    setDbFactory(db);
    await handler(
      signedEvent({
        appId: "annotator",
        method: "POST",
        subPath: "/data/labels",
        // A body claiming another namespace changes nothing: app_id is not
        // read from here, which is what makes squatting unrepresentable.
        body: { labels: [{ recordId: "rec1", key: "faces-detected", appId: "photos" }] },
      }),
      context,
    );
    const insert = db.calls(LABELS_INSERT)[0]!;
    expect(insert.values).toContain("annotator");
    expect(insert.values).not.toContain("photos");
  });

  it("never touches shared.records — a label write must not re-ship the record", async () => {
    // The single most important implementation rule: bumping records.updated_at
    // would re-ship the whole record over the Drive channel and disturb every
    // peer's watermark.
    const db = annotatorDb();
    setDbFactory(db);
    await handler(
      signedEvent({
        appId: "annotator",
        method: "POST",
        subPath: "/data/labels",
        body: { labels: [{ recordId: "rec1", key: "faces-detected" }] },
      }),
      context,
    );
    expect(db.calls(RECORDS_INSERT)).toHaveLength(0);
    expect(db.calls(RECORDS_UPDATE)).toHaveLength(0);
  });

  it("writes the whole batch as one statement", async () => {
    // A loop of single writes would blow DSQL's 3,000-rows-per-transaction
    // budget differently and cost a round trip each.
    const db = annotatorDb({
      records: [
        recordRow({ id: "rec1", type: "image/jpeg" }),
        recordRow({ id: "rec2", type: "image/jpeg" }),
      ],
    });
    setDbFactory(db);
    await handler(
      signedEvent({
        appId: "annotator",
        method: "POST",
        subPath: "/data/labels",
        body: {
          labels: [
            { recordId: "rec1", key: "faces-detected" },
            { recordId: "rec2", key: "faces-detected" },
          ],
        },
      }),
      context,
    );
    expect(db.calls(LABELS_INSERT)).toHaveLength(1);
  });

  it("400s an undeclared key", async () => {
    const db = annotatorDb({ declaredKeys: ["faces-detected"] });
    setDbFactory(db);
    const res = await handler(
      signedEvent({
        appId: "annotator",
        method: "POST",
        subPath: "/data/labels",
        body: { labels: [{ recordId: "rec1", key: "not-declared" }] },
      }),
      context,
    );
    expect(res.statusCode).toBe(400);
    expect(String(bodyOf(res).error)).toContain("not declared");
    expect(db.calls(LABELS_INSERT)).toHaveLength(0);
  });

  it("403s a label on a type the caller cannot read", async () => {
    const db = annotatorDb({ records: [recordRow({ id: "rec1", type: "audio/mp3" })] });
    setDbFactory(db);
    const res = await handler(
      signedEvent({
        appId: "annotator",
        method: "POST",
        subPath: "/data/labels",
        body: { labels: [{ recordId: "rec1", key: "faces-detected" }] },
      }),
      context,
    );
    expect(res.statusCode).toBe(403);
    expect(db.calls(LABELS_INSERT)).toHaveLength(0);
  });

  it("400s a label on a record that does not exist", async () => {
    const db = annotatorDb({ records: [] });
    setDbFactory(db);
    const res = await handler(
      signedEvent({
        appId: "annotator",
        method: "POST",
        subPath: "/data/labels",
        body: { labels: [{ recordId: "ghost", key: "faces-detected" }] },
      }),
      context,
    );
    expect(res.statusCode).toBe(400);
    expect(String(bodyOf(res).error)).toContain("does not exist");
  });

  it("400s an empty batch", async () => {
    setDbFactory(annotatorDb());
    const res = await handler(
      signedEvent({
        appId: "annotator",
        method: "POST",
        subPath: "/data/labels",
        body: { labels: [] },
      }),
      context,
    );
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /data/labels/retract", () => {
  it("tombstones rather than deleting, so the retraction can sync", async () => {
    const db = annotatorDb();
    setDbFactory(db);
    const res = await handler(
      signedEvent({
        appId: "annotator",
        method: "POST",
        subPath: "/data/labels/retract",
        body: { labels: [{ recordId: "rec1", key: "faces-detected" }] },
      }),
      context,
    );
    expect(res.statusCode).toBe(200);
    const update = db.calls(LABELS_UPDATE)[0]!;
    expect(update.text).toMatch(/set "deleted_at"/);
    expect(db.log.some((q) => /delete from "shared"\."record_labels"/.test(q.text))).toBe(false);
  });

  it("accepts a key the manifest no longer declares", async () => {
    // An uninstall or a key-dropping upgrade revokes the declaration while the
    // rows survive. Refusing this would strand an app's own rows permanently
    // out of its reach — the bug in running every write through one gate.
    const db = annotatorDb({ declaredKeys: [] });
    setDbFactory(db);
    const res = await handler(
      signedEvent({
        appId: "annotator",
        method: "POST",
        subPath: "/data/labels/retract",
        body: { labels: [{ recordId: "rec1", key: "long-gone" }] },
      }),
      context,
    );
    expect(res.statusCode).toBe(200);
  });

  it("scopes the update by the authenticated app_id", async () => {
    const db = annotatorDb();
    setDbFactory(db);
    await handler(
      signedEvent({
        appId: "annotator",
        method: "POST",
        subPath: "/data/labels/retract",
        body: { labels: [{ recordId: "rec1", key: "faces-detected" }] },
      }),
      context,
    );
    const update = db.calls(LABELS_UPDATE)[0]!;
    expect(update.text).toMatch(/"app_id" = /);
    expect(update.values).toContain("annotator");
  });
});

describe("GET /data/label-keys", () => {
  it("returns every app's declared keys, unfiltered by the caller's grants", async () => {
    const db = fakeDsqlWithGrants([]).on(LABEL_KEYS_SELECT, [
      { app_id: "annotator", key: "faces-detected", description: "Faces were found" },
      { app_id: "photos", key: "thumbnail", description: "A derived thumbnail" },
    ]);
    setDbFactory(db);
    const res = await handler(
      signedEvent({ appId: "somebody", method: "GET", subPath: "/data/label-keys" }),
      context,
    );
    expect(res.statusCode).toBe(200);
    const { labelKeys } = bodyOf(res) as {
      labelKeys: Array<{ app_id: string; label: string; description: string }>;
    };
    expect(labelKeys.map((k) => k.label)).toEqual([
      "annotator/faces-detected",
      "photos/thumbnail",
    ]);
  });
});

describe("GET /data/records with labels", () => {
  it("hydrates labels only when include=labels is requested", async () => {
    const db = fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "read" }])
      .on(RECORDS_SELECT, [recordRow({ id: "rec1", type: "image/jpeg" })])
      .on(LABELS_SELECT, [
        {
          record_id: "rec1",
          app_id: "annotator",
          key: "face-count",
          value: "3",
          record_type: "image/jpeg",
          created_at: TEST_HLC,
          updated_at: TEST_HLC,
          node_id: "test",
          deleted_at: null,
        },
      ]);
    setDbFactory(db);

    const withLabels = await handler(
      signedEvent({
        appId: "reader",
        method: "GET",
        subPath: "/data/records",
        query: { include: "labels" },
      }),
      context,
    );
    const { records } = bodyOf(withLabels) as {
      records: Array<{ labels?: Array<{ label: string; value: string }> }>;
    };
    expect(records[0].labels).toEqual([
      { app_id: "annotator", key: "face-count", value: "3", label: "annotator/face-count" },
    ]);
  });

  it("omits the labels field entirely when not requested", async () => {
    const db = fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "read" }]).on(
      RECORDS_SELECT,
      [recordRow({ id: "rec1", type: "image/jpeg" })],
    );
    setDbFactory(db);
    const res = await handler(
      signedEvent({ appId: "reader", method: "GET", subPath: "/data/records" }),
      context,
    );
    const { records } = bodyOf(res) as { records: Array<Record<string, unknown>> };
    expect("labels" in records[0]).toBe(false);
    // And no label query was issued at all.
    expect(db.calls(LABELS_SELECT)).toHaveLength(0);
  });

  it("400s labelValue without label", async () => {
    setDbFactory(fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "read" }]));
    const res = await handler(
      signedEvent({
        appId: "reader",
        method: "GET",
        subPath: "/data/records",
        query: { labelValue: "high" },
      }),
      context,
    );
    expect(res.statusCode).toBe(400);
  });

  it("400s a malformed label ref", async () => {
    setDbFactory(fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "read" }]));
    const res = await handler(
      signedEvent({
        appId: "reader",
        method: "GET",
        subPath: "/data/records",
        query: { label: "no-slash" },
      }),
      context,
    );
    expect(res.statusCode).toBe(400);
  });

  it("constrains the reverse query to the caller's readable types", async () => {
    // record_type rides in the reverse index, so this is an index condition
    // rather than a post-fetch filter — which is what lets a page come back
    // full. Here we just pin that the constraint reaches the SQL at all.
    const db = fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "read" }])
      .on(LABELS_SELECT, [])
      .on(RECORDS_SELECT, []);
    setDbFactory(db);
    const res = await handler(
      signedEvent({
        appId: "reader",
        method: "GET",
        subPath: "/data/records",
        query: { label: "annotator/faces-detected" },
      }),
      context,
    );
    expect(res.statusCode).toBe(200);
    const q = db.calls(LABELS_SELECT)[0]!;
    expect(q.values).toContain("annotator");
    expect(q.values).toContain("faces-detected");
    expect(q.values).toContain("image/jpeg");
    // Tombstones are excluded by the index's own key column, not a filter.
    expect(q.text).toMatch(/"deleted_at" is null/);
  });
});

describe("the reverse query end to end", () => {
  /** A label row as DSQL hands it back. */
  function labelRow(over: Record<string, unknown>): Record<string, unknown> {
    return {
      record_id: "rec1",
      app_id: "annotator",
      key: "faces-detected",
      // "" — a bare flag. `value` is NOT NULL now, and a fixture that still
      // carried a null would make the reverse cursor undecodable, which
      // degrades the next page into an unfiltered first page rather than
      // erroring.
      value: "",
      record_type: "image/jpeg",
      created_at: TEST_HLC,
      updated_at: TEST_HLC,
      node_id: "test",
      deleted_at: null,
      ...over,
    };
  }

  it("returns the labelled records, in the reverse index's order", async () => {
    // `query` comes back id-ascending, which is NOT the (value, record_id)
    // order the cursor is keyed on — so the handler has to restore it, or a
    // caller paging by that cursor would see rows out of order.
    const db = fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "read" }])
      .on(LABELS_SELECT, [
        labelRow({ record_id: "rec3", value: "a" }),
        labelRow({ record_id: "rec1", value: "b" }),
      ])
      .on(RECORDS_SELECT, [
        recordRow({ id: "rec1", type: "image/jpeg" }),
        recordRow({ id: "rec3", type: "image/jpeg" }),
      ]);
    setDbFactory(db);

    const res = await handler(
      signedEvent({
        appId: "reader",
        method: "GET",
        subPath: "/data/records",
        query: { label: "annotator/faces-detected" },
      }),
      context,
    );
    const { records } = bodyOf(res) as { records: Array<{ id: string }> };
    expect(records.map((r) => r.id)).toEqual(["rec3", "rec1"]);
  });

  it("passes labelValue through as an exact-match filter", async () => {
    const db = fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "read" }])
      .on(LABELS_SELECT, [])
      .on(RECORDS_SELECT, []);
    setDbFactory(db);

    await handler(
      signedEvent({
        appId: "reader",
        method: "GET",
        subPath: "/data/records",
        query: { label: "annotator/face-count", labelValue: "3" },
      }),
      context,
    );
    const q = db.calls(LABELS_SELECT)[0]!;
    expect(q.text).toMatch(/"value" = /);
    expect(q.values).toContain("3");
  });

  it("hydrates metadata and labels on the reverse path too", async () => {
    const db = fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "read" }])
      .on(LABELS_SELECT, [labelRow({ record_id: "rec1", key: "face-count", value: "3" })])
      .on(RECORDS_SELECT, [recordRow({ id: "rec1", type: "image/jpeg" })])
      .on(/from "shared"\."record_image_metadata"/, [{ record_id: "rec1", width: 4, height: 2 }]);
    setDbFactory(db);

    const res = await handler(
      signedEvent({
        appId: "reader",
        method: "GET",
        subPath: "/data/records",
        query: { label: "annotator/face-count", include: "metadata,labels" },
      }),
      context,
    );
    const { records } = bodyOf(res) as {
      records: Array<{ labels?: unknown[]; metadata?: Record<string, unknown> | null }>;
    };
    expect(records[0].labels).toHaveLength(1);
    expect(records[0].metadata).toMatchObject({ width: 4, height: 2 });
  });

  it("narrows hydration to the namespaces labelApps asks for", async () => {
    const db = fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "read" }])
      .on(RECORDS_SELECT, [recordRow({ id: "rec1", type: "image/jpeg" })])
      .on(LABELS_SELECT, [
        labelRow({ record_id: "rec1", app_id: "annotator" }),
        labelRow({ record_id: "rec1", app_id: "photos", key: "thumbnail" }),
      ]);
    setDbFactory(db);

    const res = await handler(
      signedEvent({
        appId: "reader",
        method: "GET",
        subPath: "/data/records",
        query: { include: "labels", labelApps: "photos" },
      }),
      context,
    );
    const { records } = bodyOf(res) as {
      records: Array<{ labels: Array<{ app_id: string }> }>;
    };
    expect(records[0].labels.map((l) => l.app_id)).toEqual(["photos"]);
  });

  it("hands back a nextCursor and accepts it on the next request", async () => {
    // limit + 1 rows come back, so the page is full and there is more.
    const db = fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "read" }])
      .on(LABELS_SELECT, [labelRow({ record_id: "rec1" }), labelRow({ record_id: "rec2" })])
      .on(RECORDS_SELECT, [recordRow({ id: "rec1", type: "image/jpeg" })]);
    setDbFactory(db);

    const first = await handler(
      signedEvent({
        appId: "reader",
        method: "GET",
        subPath: "/data/records",
        query: { label: "annotator/faces-detected", limit: "1" },
      }),
      context,
    );
    const { nextCursor, hasMore } = bodyOf(first) as {
      nextCursor: string | null;
      hasMore: boolean;
    };
    expect(hasMore).toBe(true);
    expect(nextCursor).toBeTruthy();

    // The cursor is opaque and round-trips into the label query's predicate.
    db.log.length = 0;
    await handler(
      signedEvent({
        appId: "reader",
        method: "GET",
        subPath: "/data/records",
        query: { label: "annotator/faces-detected", limit: "1", cursor: nextCursor! },
      }),
      context,
    );
    expect(db.calls(LABELS_SELECT)[0]!.text).toMatch(/"record_id" > /);
  });

  it("drops a label whose record is gone, without ending the page", async () => {
    // The orphan case — a delete that raced sync. It shortens a page, which is
    // why the contract is "page until nextCursor is null" rather than "stop on
    // a short page".
    const db = fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "read" }])
      .on(LABELS_SELECT, [
        labelRow({ record_id: "rec1" }),
        labelRow({ record_id: "gone" }),
        labelRow({ record_id: "rec2" }),
      ])
      .on(RECORDS_SELECT, [
        recordRow({ id: "rec1", type: "image/jpeg" }),
        recordRow({ id: "rec2", type: "image/jpeg" }),
      ]);
    setDbFactory(db);

    const res = await handler(
      signedEvent({
        appId: "reader",
        method: "GET",
        subPath: "/data/records",
        query: { label: "annotator/faces-detected", limit: "2" },
      }),
      context,
    );
    const { records, hasMore, nextCursor } = bodyOf(res) as {
      records: Array<{ id: string }>;
      hasMore: boolean;
      nextCursor: string | null;
    };
    // The page held two label rows — rec1 and the orphan — and comes back with
    // ONE record. That short page is not the end of the results, and a caller
    // that stopped here would silently miss rec2.
    expect(records.map((r) => r.id)).toEqual(["rec1"]);
    expect(hasMore).toBe(true);
    expect(nextCursor).not.toBeNull();
  });

  it("lets an all-access caller see every type", async () => {
    // Drive holds no per-type grants; `readableTypes: undefined` is what says
    // "no constraint" rather than "constrain to the empty set".
    const db = fakeDsqlWithGrants([])
      .on(/from "shared"\."app_registry"/, [{ app_id: "starkeep-drive" }])
      .on(LABELS_SELECT, [labelRow({ record_id: "rec1", record_type: "audio/mp3" })])
      .on(RECORDS_SELECT, [recordRow({ id: "rec1", type: "audio/mp3" })]);
    setDbFactory(db);

    const res = await handler(
      signedEvent({
        appId: "starkeep-drive",
        method: "GET",
        subPath: "/data/records",
        query: { label: "annotator/faces-detected" },
      }),
      context,
    );
    expect(res.statusCode).toBe(200);
    const q = db.calls(LABELS_SELECT)[0]!;
    // No record_type constraint at all, rather than an empty IN-list.
    expect(q.text).not.toMatch(/"record_type" in/);
  });
});

describe("GET /data/label-keys?app=", () => {
  it("filters the registry to one app", async () => {
    const db = fakeDsqlWithGrants([]).on(LABEL_KEYS_SELECT, [
      { app_id: "annotator", key: "faces-detected", description: "d" },
    ]);
    setDbFactory(db);
    const res = await handler(
      signedEvent({
        appId: "somebody",
        method: "GET",
        subPath: "/data/label-keys",
        query: { app: "annotator" },
      }),
      context,
    );
    expect(res.statusCode).toBe(200);
    const q = db.calls(LABEL_KEYS_SELECT)[0]!;
    expect(q.text).toMatch(/"app_id" = /);
    expect(q.values).toContain("annotator");
  });
});

describe("labels supplied on record create", () => {
  const VALID_HASH = "b".repeat(64);

  function createDb(over?: { declaredKeys?: string[] }) {
    return fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "readwrite" }])
      .on(RECORDS_INSERT, [])
      .on(
        LABEL_KEYS_SELECT,
        (over?.declaredKeys ?? ["thumbnail"]).map((key) => ({
          app_id: "photos",
          key,
          description: "d",
        })),
      )
      .on(/from "shared"\."records" where "id" in/, (q) => [
        recordRow({ id: String(q.values[0]), type: "image/jpeg" }),
      ])
      // The write path reads this app's stored values for the batch's records
      // so the value cap counts what is already there. A brand-new record has
      // none.
      .on(LABELS_BY_IDS, [])
      .on(LABELS_INSERT, []);
  }

  function createEvent(labels: Array<{ key: string; value?: string }>) {
    return signedEvent({
      appId: "photos",
      method: "POST",
      subPath: "/data/records",
      body: {
        type: "image/jpeg",
        contentType: "image/jpeg",
        contentHash: VALID_HASH,
        sizeBytes: 3,
        labels,
      },
    });
  }

  it("keeps the record and reports the failure when a label is rejected", async () => {
    // The record and its labels share a request but not a transaction, so the
    // record cannot be un-written. Claiming the whole call failed would have
    // the caller re-upload bytes that are already stored.
    s3Mock.on(HeadObjectCommand).resolves({});
    const db = createDb({ declaredKeys: [] });
    setDbFactory(db);

    const res = await handler(createEvent([{ key: "thumbnail" }]), context);
    expect(res.statusCode).toBe(400);
    const body = bodyOf(res) as {
      error: string;
      recordCreated: boolean;
      record: { id: string };
    };
    expect(body.error).toBe("InvalidLabelWrite");
    expect(body.recordCreated).toBe(true);
    expect(body.record.id).toBeTruthy();
    // The record row was written; only the labels were not.
    expect(db.calls(RECORDS_INSERT)).toHaveLength(1);
    expect(db.calls(LABELS_INSERT)).toHaveLength(0);
  });
});

describe("DELETE /data/records/:id cascades to labels", () => {
  it("tombstones the record's labels in the same request", async () => {
    // DSQL has no foreign keys, so nothing cascades for us — the delete path
    // has to do it by hand or the labels outlive their record as orphans.
    const db = fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "readwrite" }])
      .on(RECORDS_SELECT, [recordRow({ id: "rec1", type: "image/jpeg" })])
      .on(RECORDS_UPDATE, [])
      .on(LABELS_UPDATE, []);
    setDbFactory(db);

    const res = await handler(
      signedEvent({ appId: "owner", method: "DELETE", subPath: "/data/records/rec1" }),
      context,
    );
    expect(res.statusCode).toBe(200);

    const labelUpdate = db.calls(LABELS_UPDATE)[0];
    expect(labelUpdate, "no label cascade was issued").toBeTruthy();
    expect(labelUpdate!.text).toMatch(/set "deleted_at"/);
    expect(labelUpdate!.values).toContain("rec1");
    // Crosses app namespaces on purpose — no app_id predicate, because every
    // app's assertions about the record go with the record.
    expect(labelUpdate!.text).not.toMatch(/"app_id" = /);
  });
});
