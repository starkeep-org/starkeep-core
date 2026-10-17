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
import type { APIGatewayEvent, LambdaContext } from "../src/handler-utils.js";
import { installUserTokenFixture, mintTestUserToken } from "./user-token.js";
import { createSharedSchema } from "../../../../storage-aurora-dsql/__tests__/pg-shared-schema.js";

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

type HandlerModule = typeof import("../src/api-handler.js");
let handler: HandlerModule["handler"];
let setDbFactory: HandlerModule["__setDatabaseClientFactoryForTests"];
const tokens: Record<string, string> = {};
let pg: PGlite;

beforeAll(async () => {
  process.env.STACK_PREFIX = "teststack";
  process.env.AURORA_ENDPOINT = "pglite.test";
  process.env.S3_BUCKET = "fake-bucket";
  process.env.AWS_REGION = "us-east-1";
  process.env.CLOUDFRONT_SIGNING_PARAM = CF_SIGNING_PARAM;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  const mod = await import("../src/api-handler.js");
  handler = mod.handler;
  setDbFactory = mod.__setDatabaseClientFactoryForTests;
  await installUserTokenFixture();
  tokens[A] = await mintTestUserToken({ sub: A });
  tokens[B] = await mintTestUserToken({ sub: B });
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
  ssmMock.on(GetParameterCommand).callsFake(async (input: { Name?: string }) => {
    if (input.Name === CF_SIGNING_PARAM) {
      return {
        Parameter: {
          Value: JSON.stringify({ keyPairId: "KTEST", domain: "dtest.cloudfront.net", privateKey: cfKeyPair.privateKey }),
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

async function call(userId: string, method: string, subPath: string, body?: unknown) {
  const res = await handler(as(userId, method, subPath, body), context);
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {} };
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

    const label = await call(B, "POST", "/data/labels", { labels: [{ recordId: id, key: "faces", value: "Eve" }] });
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

  it("B cannot delete A's record", async () => {
    const id = await aWritesAPhoto();

    expect((await call(B, "DELETE", `/data/records/${id}`)).status).toBe(404);
    // The get route answers 404 for a deleted record, so A's 200 is the proof.
    expect((await call(A, "GET", `/data/records/${id}`)).status).toBe(200);
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
