/**
 * Public shares through the broker's own routes, against one real Postgres.
 *
 * The owner creates a public share of an album label, and an anonymous
 * visitor reads it through `GET /public-shares/<token>/items`. The cases pin
 * what the proposal's section "What a public share admits" promises: the
 * visitor sees signed stand-ins and nothing that names or reaches an
 * original; a child carrying the album label admits nothing; the owner alone
 * manages the share, from a session or a signed-in desktop; and expiry,
 * revocation and link replacement each stop the old link.
 *
 * See `~/projects/starkeep/proposal-public-sharing-albums-2026-11-05.md` and
 * `~/projects/starkeep/proposal-public-links-from-any-device-2026-11-05.md`.
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

const PHOTOS = "photos";
const A = "user-a";
const B = "user-b";
const ALBUM = "4de58a3c4d2a33014de58a3c4d2a3301";
const ORIGINAL_HASH = "a".repeat(64);
const STAND_IN_HASH = "b".repeat(64);
const CROP_HASH = "d".repeat(64);
const BARE_HASH = "e".repeat(64);

type HandlerModule = typeof import("../../src/api-handler.js");
let handler: HandlerModule["handler"];
let setDbFactory: HandlerModule["__setDatabaseClientFactoryForTests"];
let takeOverlapRefusals: HandlerModule["__takeOverlapRefusalsForTests"];
const tokens: Record<string, string> = {};
let deviceToken: string;
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
  takeOverlapRefusals = mod.__takeOverlapRefusalsForTests;
  await installUserTokenFixture();
  tokens[A] = await mintTestUserToken({ sub: A });
  tokens[B] = await mintTestUserToken({ sub: B });
  process.env.STARKEEP_DEVICE_USER_POOL_CLIENT_ID = DEVICE_CLIENT_ID;
  deviceToken = await mintTestUserToken({ sub: A, aud: DEVICE_CLIENT_ID });
});

afterAll(() => {
  setDbFactory(null);
});

beforeEach(async () => {
  pg = new PGlite();
  await pg.waitReady;
  await createSharedSchema(pg);
  await pg.exec(`
    INSERT INTO shared.access_grants (app_id, type_id, access, metadata_write) VALUES
      ('${PHOTOS}', 'image/jpeg', 'readwrite', true),
      ('${PHOTOS}', 'image/avif', 'readwrite', true),
      ('${PHOTOS}', 'video/mp4', 'readwrite', true),
      ('${PHOTOS}', 'video/webm', 'readwrite', true);
    INSERT INTO shared.app_label_keys (app_id, key, description) VALUES
      ('${PHOTOS}', 'album', null),
      ('${PHOTOS}', 'derived', null);
    INSERT INTO public_sharing.app_capabilities (app_id) VALUES ('${PHOTOS}');
    CREATE SCHEMA app_starkeep_drive;
    CREATE TABLE app_starkeep_drive._starkeep_byte_coverage (
      user_id text NOT NULL,
      node_id text NOT NULL,
      hlc text NOT NULL,
      PRIMARY KEY (user_id, node_id)
    );
    CREATE SCHEMA app_photos;
  `);
  await createAppNodeWatermarks(pg, "app_starkeep_drive");
  await createAppNodeWatermarks(pg, "app_photos");
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
  expect(takeOverlapRefusals()).toEqual([]);
});

function parse(res: { statusCode: number; body?: string; headers?: Record<string, string> }) {
  return {
    status: res.statusCode,
    headers: res.headers ?? {},
    body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {},
    raw: res.body ?? "",
  };
}

async function call(userId: string, method: string, subPath: string, body?: unknown) {
  const bodyless = method === "GET" || method === "DELETE";
  const bodyStr = body === undefined ? undefined : JSON.stringify(body);
  const headers = signRequest({
    appId: PHOTOS,
    hmacSecret: `secret-${PHOTOS}`,
    method,
    path: subPath.split("?")[0]!,
    ...(bodyless ? {} : { body: bodyStr }),
  });
  const [path, search] = subPath.split("?");
  const event: APIGatewayEvent = {
    rawPath: `/apps/${PHOTOS}${path}`,
    requestContext: { http: { method } },
    headers: { ...headers, "X-Starkeep-User-Token": tokens[userId]! },
    ...(search ? { queryStringParameters: Object.fromEntries(new URLSearchParams(search)) } : {}),
    ...(bodyStr !== undefined ? { body: bodyStr } : {}),
  };
  return parse(await handler(event, context));
}

/**
 * A signed-in desktop, as its local data server forwards a request: user A's
 * device token alone, with no app signature.
 */
async function device(method: string, subPath: string, body?: unknown) {
  const bodyStr = body === undefined ? undefined : JSON.stringify(body);
  return parse(
    await handler(
      {
        rawPath: `/apps/${PHOTOS}${subPath}`,
        requestContext: { http: { method } },
        headers: { "X-Starkeep-User-Token": deviceToken },
        ...(bodyStr !== undefined ? { body: bodyStr } : {}),
      },
      context,
    ),
  );
}

/** An anonymous visitor: no signature, no token, no cookie. */
async function visit(linkToken: string, cursor?: string) {
  return parse(
    await handler(
      {
        rawPath: `/public-shares/${linkToken}/items`,
        requestContext: { http: { method: "GET" } },
        headers: {},
        ...(cursor ? { queryStringParameters: { cursor } } : {}),
      },
      context,
    ),
  );
}

async function register(userId: string, body: Record<string, unknown>): Promise<string> {
  const res = await call(userId, "POST", "/data/records", body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body["record"] as { id: string }).id;
}

/** An original at 4000×3000 (self-canonical), its 2560 stand-in, and the album label. */
async function albumWithOnePhoto(userId: string = A) {
  const original = await register(userId, {
    type: "image/jpeg",
    contentType: "image/jpeg",
    contentHash: ORIGINAL_HASH,
    sizeBytes: 3_000_000,
    fileName: "beach.jpg",
    fidelity: 4000,
    metadata: { width: 4000, height: 3000 },
  });
  const standIn = await register(userId, {
    type: "image/avif",
    contentType: "image/avif",
    contentHash: STAND_IN_HASH,
    sizeBytes: 300_000,
    fileName: "beach-2560.avif",
    parentId: original,
    standIn: { role: "smaller", fidelity: 2560 },
  });
  await label(userId, original);
  return { original, standIn };
}

async function label(userId: string, recordId: string) {
  const res = await call(userId, "POST", "/data/labels", {
    labels: [{ recordId, key: "album", value: ALBUM }],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function share(userId: string = A, extra: Record<string, unknown> = {}) {
  const res = await call(userId, "POST", "/data/public-shares", {
    labelKey: "album",
    labelValue: ALBUM,
    title: "Summer",
    lifetime: "7d",
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body["publicShare"] as { id: string; linkToken: string; expiresAtMs: number | null };
}

describe("a visitor of a public share", () => {
  it("sees the album's stand-in and nothing that names or reaches the original", async () => {
    const { original, standIn } = await albumWithOnePhoto();
    const created = await share();

    const page = await visit(created.linkToken);
    expect(page.status, page.raw).toBe(200);
    expect(page.headers["Cache-Control"]).toBe("public, max-age=60");
    expect(page.body["title"]).toBe("Summer");
    const items = page.body["items"] as Array<{
      id: string;
      category: string;
      width: number;
      height: number;
      sizes: Array<{ longEdge: number; url: string }>;
    }>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ category: "image", width: 2560, height: 1920 });
    expect(items[0]!.sizes.map((s) => s.longEdge)).toEqual([2560]);
    expect(items[0]!.sizes[0]!.url).toContain(`shared/${A}/image/bb/${STAND_IN_HASH}?`);

    // No original key, hash or record id anywhere in the answer.
    for (const secret of [ORIGINAL_HASH, original, standIn, "beach"]) {
      expect(page.raw).not.toContain(secret);
    }
  });

  it("sees a video's poster frame and playable stand-in, never the video itself", async () => {
    const VIDEO_HASH = "1".repeat(64);
    const POSTER_HASH = "2".repeat(64);
    const WEBM_HASH = "3".repeat(64);
    const video = await register(A, {
      type: "video/mp4",
      contentType: "video/mp4",
      contentHash: VIDEO_HASH,
      sizeBytes: 50_000_000,
      fileName: "clip.mp4",
      fidelity: 8000,
    });
    await register(A, {
      type: "image/jpeg",
      contentType: "image/jpeg",
      contentHash: POSTER_HASH,
      sizeBytes: 90_000,
      fileName: "clip-poster.jpg",
      parentId: video,
      labels: [{ key: "derived", value: "video-poster-720p" }],
      metadata: { width: 1280, height: 720 },
    });
    await register(A, {
      type: "video/webm",
      contentType: "video/webm",
      contentHash: WEBM_HASH,
      sizeBytes: 5_000_000,
      fileName: "clip-2000.webm",
      parentId: video,
      standIn: { role: "smaller", fidelity: 2000 },
    });
    await label(A, video);
    const created = await share();

    const page = await visit(created.linkToken);
    expect(page.status, page.raw).toBe(200);
    const items = page.body["items"] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ category: "video", width: 1280, height: 720 });
    expect(JSON.stringify(items[0]!["sizes"])).toContain(POSTER_HASH);
    expect((items[0]!["playback"] as { url: string }).url).toContain(WEBM_HASH);
    expect(page.raw).not.toContain(VIDEO_HASH);
  });

  it("sees nothing through a label on a child record", async () => {
    const { original } = await albumWithOnePhoto();
    const crop = await register(A, {
      type: "image/jpeg",
      contentType: "image/jpeg",
      contentHash: CROP_HASH,
      sizeBytes: 1_000,
      fileName: "crop.jpg",
      parentId: original,
    });
    await label(A, crop);
    const created = await share();

    const page = await visit(created.linkToken);
    expect((page.body["items"] as unknown[]).length).toBe(1);
    expect(page.raw).not.toContain(CROP_HASH);
  });

  it("does not see a member with no stand-in yet", async () => {
    const bare = await register(A, {
      type: "image/jpeg",
      contentType: "image/jpeg",
      contentHash: BARE_HASH,
      sizeBytes: 2_000_000,
      fileName: "bare.jpg",
      fidelity: 3000,
      metadata: { width: 3000, height: 2000 },
    });
    await label(A, bare);
    const created = await share();

    const page = await visit(created.linkToken);
    expect(page.body["items"]).toEqual([]);
    expect(page.raw).not.toContain(BARE_HASH);
  });

  it("never sees another user's photos carrying the same label value", async () => {
    await albumWithOnePhoto(B);
    const created = await share(A);
    const page = await visit(created.linkToken);
    expect(page.body["items"]).toEqual([]);
    expect(page.raw).not.toContain(B);
  });

  it("is refused an unknown token, a revoked share and an expired one", async () => {
    await albumWithOnePhoto();
    expect((await visit("A".repeat(22))).status).toBe(404);

    const created = await share();
    expect((await call(A, "DELETE", `/data/public-shares/${created.id}`)).status).toBe(200);
    expect((await visit(created.linkToken)).status).toBe(404);

    const expiring = await share();
    await pg.query("UPDATE public_sharing.public_shares SET expires_at_ms = 1 WHERE id = $1", [
      expiring.id,
    ]);
    expect((await visit(expiring.linkToken)).status).toBe(410);
  });

  it("is refused once the app loses the capability", async () => {
    await albumWithOnePhoto();
    const created = await share();
    await pg.query("DELETE FROM public_sharing.app_capabilities");
    expect((await visit(created.linkToken)).status).toBe(404);
  });

  it("loses the old link when the owner replaces it", async () => {
    await albumWithOnePhoto();
    const created = await share();
    const rotated = await call(A, "PATCH", `/data/public-shares/${created.id}`, {
      rotateLink: true,
    });
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
    const next = rotated.body["publicShare"] as { linkToken: string };
    expect(next.linkToken).not.toBe(created.linkToken);
    expect((await visit(created.linkToken)).status).toBe(404);
    expect((await visit(next.linkToken)).status).toBe(200);
  });

  it("gets no error and no wider page for a cursor it made up", async () => {
    // The cursor is the one free input. A malformed one cannot widen the
    // query: the album predicate and the owner scope are not in it.
    await albumWithOnePhoto();
    await albumWithOnePhoto(B);
    const created = await share();
    const page = await visit(created.linkToken, "not-a-cursor");
    expect(page.status).toBeLessThan(500);
    expect(page.raw).not.toContain(B);
  });
});

describe("the owner's public-share routes", () => {
  it("default to a 30-day lifetime, and allow never", async () => {
    const before = Date.now();
    const defaulted = await share(A, { lifetime: undefined });
    expect(defaulted.expiresAtMs).toBeGreaterThanOrEqual(before + 30 * 86_400_000);
    const forever = await share(A, { lifetime: "never" });
    expect(forever.expiresAtMs).toBeNull();
    const listed = await call(A, "GET", `/data/public-shares?labelKey=album&labelValue=${ALBUM}`);
    expect((listed.body["publicShares"] as unknown[]).length).toBe(2);
  });

  it("refuse another user's share as missing", async () => {
    const created = await share(A);
    expect((await call(B, "GET", `/data/public-shares/${created.id}`)).status).toBe(404);
    expect((await call(B, "DELETE", `/data/public-shares/${created.id}`)).status).toBe(404);
    expect(
      (await call(B, "PATCH", `/data/public-shares/${created.id}`, { lifetime: "never" })).status,
    ).toBe(404);
    expect((await call(B, "GET", "/data/public-shares")).body["publicShares"]).toEqual([]);
    expect((await call(A, "GET", `/data/public-shares/${created.id}`)).status).toBe(200);
  });

  it("refuse creation without the approved capability", async () => {
    await pg.query("DELETE FROM public_sharing.app_capabilities");
    const res = await call(A, "POST", "/data/public-shares", {
      labelKey: "album",
      labelValue: ALBUM,
      title: "Summer",
    });
    expect(res.status).toBe(403);
    expect((await pg.query("SELECT * FROM public_sharing.public_shares")).rows).toEqual([]);
  });

  it("refuse an undeclared label key and a bad lifetime", async () => {
    const undeclared = await call(A, "POST", "/data/public-shares", {
      labelKey: "faces",
      labelValue: "Alice",
      title: "Alice",
    });
    expect(undeclared.status).toBe(400);
    const badLifetime = await call(A, "POST", "/data/public-shares", {
      labelKey: "album",
      labelValue: ALBUM,
      title: "Summer",
      lifetime: "5y",
    });
    expect(badLifetime.status).toBe(400);
  });

  it("let a signed-in desktop create, change and stop a link, as its local data server forwards", async () => {
    await albumWithOnePhoto();
    const created = await device("POST", "/data/public-shares", {
      labelKey: "album",
      labelValue: ALBUM,
      title: "Summer",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const made = created.body["publicShare"] as { id: string; linkToken: string };
    expect((await visit(made.linkToken)).status).toBe(200);
    // The device acts for its user: the share is A's, as a session's would be.
    expect((await call(A, "GET", `/data/public-shares/${made.id}`)).status).toBe(200);
    const listed = await device("GET", "/data/public-shares");
    expect((listed.body["publicShares"] as unknown[]).length).toBe(1);
    expect(
      (await device("PATCH", `/data/public-shares/${made.id}`, { lifetime: "1d" })).status,
    ).toBe(200);
    expect((await device("DELETE", `/data/public-shares/${made.id}`)).status).toBe(200);
    expect((await visit(made.linkToken)).status).toBe(404);
  });

  it("hold a signed-in desktop to the capability and to its own user's shares", async () => {
    const others = await share(B);
    expect((await device("GET", `/data/public-shares/${others.id}`)).status).toBe(404);
    expect((await device("DELETE", `/data/public-shares/${others.id}`)).status).toBe(404);
    await pg.query("DELETE FROM public_sharing.app_capabilities");
    const res = await device("POST", "/data/public-shares", {
      labelKey: "album",
      labelValue: ALBUM,
      title: "Summer",
    });
    expect(res.status).toBe(403);
    expect((await pg.query("SELECT owner_user_id FROM public_sharing.public_shares")).rows).toEqual(
      [{ owner_user_id: B }],
    );
  });
});
