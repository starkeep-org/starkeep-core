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
import { S3Client } from "@aws-sdk/client-s3";
import { signRequest } from "@starkeep/app-client";
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

const TEST_HLC = serializeHLC({ wallTime: Date.UTC(2026, 0, 1), counter: 0, nodeId: "test" });

const RECORDS_SELECT = /select \* from "shared"\."records"/;
const RECORDS_INSERT = /insert into "shared"\."records"/;
const RECORDS_UPDATE = /update "shared"\."records"/;
const LABELS_INSERT = /insert into "shared"\."record_labels"/;
const LABELS_UPDATE = /update "shared"\."record_labels"/;
const LABELS_SELECT = /select \* from "shared"\."record_labels"/;
const LABEL_KEYS_SELECT = /from "shared"\."app_label_keys"/;

/** Read-only grant on image/jpeg, with two declared label keys. */
function annotatorDb(over?: {
  records?: Record<string, unknown>[];
  declaredKeys?: string[];
}): FakeDsql {
  return fakeDsqlWithGrants([{ type_id: "image/jpeg", access: "read" }])
    .on(LABEL_KEYS_SELECT, (over?.declaredKeys ?? ["faces-detected", "face-count"]).map((key) => ({
      app_id: "annotator",
      key,
      description: `desc for ${key}`,
    })))
    .on(RECORDS_SELECT, over?.records ?? [recordRow({ id: "rec1", type: "image/jpeg" })])
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
      records: Array<{ labels?: Array<{ label: string; value: string | null }> }>;
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
