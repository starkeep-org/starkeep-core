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
 * Record shares name one record. Photos' record share shows one stand-in;
 * Starkeep Drive's direct link (`GET /public-shares/<token>/file/<name>`) redirects
 * to a file's original, or to a photo's or a video's stand-in or original as
 * the share says, and never to an archived or missing original.
 *
 * See `~/projects/starkeep/proposal-public-sharing-albums-2026-11-05.md` and
 * `~/projects/starkeep/proposal-public-links-from-any-device-2026-11-05.md`,
 * and `~/projects/starkeep/plan-public-links-single-items-and-drive-2026-11-05.md`.
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
import { dropAllUserSchemas } from "../../../../../storage-aurora-dsql/__tests__/pglite-reset.js";

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
const DRIVE = "starkeep-drive";
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
  // One PGlite per file; each test starts from dropAllUserSchemas + the seed.
  pg = new PGlite();
  await pg.waitReady;
});

afterAll(async () => {
  await pg.close();
  setDbFactory(null);
});

beforeEach(async () => {
  await dropAllUserSchemas(pg);
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
    INSERT INTO public_sharing.app_capabilities (app_id) VALUES ('${PHOTOS}'), ('${DRIVE}');
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

afterEach(() => {
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
  return callAs(PHOTOS, userId, method, subPath, body);
}

async function callAs(
  appId: string,
  userId: string,
  method: string,
  subPath: string,
  body?: unknown,
) {
  const bodyless = method === "GET" || method === "DELETE";
  const bodyStr = body === undefined ? undefined : JSON.stringify(body);
  const headers = signRequest({
    appId,
    hmacSecret: `secret-${appId}`,
    method,
    path: subPath.split("?")[0]!,
    ...(bodyless ? {} : { body: bodyStr }),
  });
  const [path, search] = subPath.split("?");
  const event: APIGatewayEvent = {
    rawPath: `/apps/${appId}${path}`,
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

/** An anonymous visitor of a direct link. */
async function visitFile(linkToken: string) {
  const res = await handler(
    {
      rawPath: `/public-shares/${linkToken}/file/notes.md`,
      requestContext: { http: { method: "GET" } },
      headers: {},
    },
    context,
  );
  const { headers } = res as { headers?: Record<string, string> };
  return { status: res.statusCode, headers: headers ?? {}, raw: res.body ?? "" };
}

async function register(
  userId: string,
  body: Record<string, unknown>,
  appId: string = PHOTOS,
): Promise<string> {
  const res = await callAs(appId, userId, "POST", "/data/records", body);
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

const ALBUM_SOURCE = { kind: "label", key: "album", value: ALBUM };

async function share(userId: string = A, extra: Record<string, unknown> = {}) {
  const res = await call(userId, "POST", "/data/public-shares", {
    source: ALBUM_SOURCE,
    title: "Summer",
    lifetime: "7d",
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body["publicShare"] as { id: string; linkToken: string; expiresAtMs: number | null };
}

/** A record share as `appId`. Answers the raw response, so a refusal can be asserted. */
async function shareRecord(
  appId: string,
  recordId: string,
  extra: Record<string, unknown> = {},
  userId: string = A,
) {
  return callAs(appId, userId, "POST", "/data/public-shares", {
    source: { kind: "record", recordId },
    title: "Beach",
    lifetime: "1d",
    ...extra,
  });
}

function made(res: { status: number; body: Record<string, unknown> }) {
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body["publicShare"] as { id: string; linkToken: string; serves: string };
}

async function markAvailability(key: string, state: "archived" | "restoring") {
  await pg.query(
    `INSERT INTO shared.object_availability
       (user_id, object_storage_key, state, tier, expected_latency_hours, observed_at_ms)
     VALUES ($1, $2, $3, 'DEEP_ARCHIVE', 12, 1)`,
    [A, key, state],
  );
}

const PDF_HASH = "f".repeat(64);
const PDF_KEY = `shared/${A}/document/ff/${PDF_HASH}`;
const ORIGINAL_KEY = `shared/${A}/image/aa/${ORIGINAL_HASH}`;

/** A PDF, written as Drive, which reads and writes every type. */
async function pdf(userId: string = A, contentHash: string = PDF_HASH) {
  return register(
    userId,
    {
      type: "document/pdf",
      contentType: "application/pdf",
      contentHash,
      sizeBytes: 40_000,
      fileName: "trip-notes.pdf",
    },
    DRIVE,
  );
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

  it("stops seeing a photo once the owner takes it out of the album", async () => {
    const { original } = await albumWithOnePhoto();
    const created = await share();
    expect((await visit(created.linkToken)).body["items"]).toHaveLength(1);

    const retracted = await call(A, "POST", "/data/labels/retract", {
      labels: [{ recordId: original, key: "album", value: ALBUM }],
    });
    expect(retracted.status, JSON.stringify(retracted.body)).toBe(200);

    const page = await visit(created.linkToken);
    expect(page.status, page.raw).toBe(200);
    expect(page.body["items"]).toEqual([]);
    expect(page.raw).not.toContain(STAND_IN_HASH);
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
      source: ALBUM_SOURCE,
      title: "Summer",
    });
    expect(res.status).toBe(403);
    expect((await pg.query("SELECT * FROM public_sharing.public_shares")).rows).toEqual([]);
  });

  it("refuse an undeclared label key and a bad lifetime", async () => {
    const undeclared = await call(A, "POST", "/data/public-shares", {
      source: { kind: "label", key: "faces", value: "Alice" },
      title: "Alice",
    });
    expect(undeclared.status).toBe(400);
    const badLifetime = await call(A, "POST", "/data/public-shares", {
      source: ALBUM_SOURCE,
      title: "Summer",
      lifetime: "5y",
    });
    expect(badLifetime.status).toBe(400);
    const original = await call(A, "POST", "/data/public-shares", {
      source: ALBUM_SOURCE,
      serves: "original",
      title: "Summer",
    });
    expect(original.status).toBe(400);
  });

  it("let a signed-in desktop create, change and stop a link, as its local data server forwards", async () => {
    await albumWithOnePhoto();
    const created = await device("POST", "/data/public-shares", {
      source: ALBUM_SOURCE,
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
      source: ALBUM_SOURCE,
      title: "Summer",
    });
    expect(res.status).toBe(403);
    expect((await pg.query("SELECT owner_user_id FROM public_sharing.public_shares")).rows).toEqual(
      [{ owner_user_id: B }],
    );
  });
});

describe("a record share", () => {
  it("from Photos shows one photo's stand-in on the items page and through the direct link", async () => {
    const { original } = await albumWithOnePhoto();
    const created = made(await shareRecord(PHOTOS, original));
    expect(created.serves).toBe("stand-in");

    const page = await visit(created.linkToken);
    expect(page.status, page.raw).toBe(200);
    expect(page.body["source"]).toBe("record");
    const items = page.body["items"] as Array<{ sizes: Array<{ url: string }> }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.sizes[0]!.url).toContain(STAND_IN_HASH);
    expect(page.raw).not.toContain(ORIGINAL_HASH);

    const file = await visitFile(created.linkToken);
    expect(file.status).toBe(302);
    expect(file.headers["Location"]).toContain(STAND_IN_HASH);
    expect(file.headers["Location"]).not.toContain(ORIGINAL_HASH);
    expect(file.headers["Referrer-Policy"]).toBe("no-referrer");
  });

  it("from Photos is refused the original", async () => {
    const { original } = await albumWithOnePhoto();
    const res = await shareRecord(PHOTOS, original, { serves: "original" });
    expect(res.status).toBe(403);
    expect((await pg.query("SELECT * FROM public_sharing.public_shares")).rows).toEqual([]);
  });

  it("from Drive serves a photo's largest stand-in by default, named in its own format", async () => {
    const { original } = await albumWithOnePhoto();
    const created = made(await shareRecord(DRIVE, original));
    expect(created.serves).toBe("stand-in");
    const file = await visitFile(created.linkToken);
    expect(file.status).toBe(302);
    const location = new URL(file.headers["Location"]!);
    expect(location.pathname).toContain(STAND_IN_HASH);
    expect(location.searchParams.get("response-content-type")).toBe("image/avif");
    expect(location.searchParams.get("response-content-disposition")).toMatch(
      /^inline; filename="Beach\.avif"/,
    );
  });

  it("from Drive serves a photo's original when asked, named after the title", async () => {
    const { original } = await albumWithOnePhoto();
    const created = made(await shareRecord(DRIVE, original, { serves: "original" }));
    expect(created.serves).toBe("original");
    const file = await visitFile(created.linkToken);
    expect(file.status, file.raw).toBe(302);
    const location = new URL(file.headers["Location"]!);
    expect(location.pathname).toBe(`/${ORIGINAL_KEY}`);
    expect(location.searchParams.get("response-content-type")).toBe("image/jpeg");
    expect(location.searchParams.get("response-content-disposition")).toMatch(
      /^inline; filename="Beach\.jpg"/,
    );
    // The items page still never signs the original, whatever the share says.
    const page = await visit(created.linkToken);
    expect(page.raw).not.toContain(ORIGINAL_HASH);
  });

  it("from Drive serves a video's playable stand-in, or the video itself", async () => {
    const VIDEO_HASH = "1".repeat(64);
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
      contentHash: "2".repeat(64),
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
    // The poster is labelled in Photos' derived key, which Drive's share does
    // not read; the direct link needs no poster.
    const original = made(await shareRecord(DRIVE, video, { serves: "original" }));
    const toOriginal = await visitFile(original.linkToken);
    expect(toOriginal.status, toOriginal.raw).toBe(302);
    expect(toOriginal.headers["Location"]).toContain(VIDEO_HASH);

    const standIn = made(await shareRecord(DRIVE, video));
    const toStandIn = await visitFile(standIn.linkToken);
    expect(toStandIn.status, toStandIn.raw).toBe(302);
    expect(toStandIn.headers["Location"]).toContain(WEBM_HASH);
    expect(toStandIn.headers["Location"]).not.toContain(VIDEO_HASH);
  });

  it("from Drive serves a file's original, whatever serves was asked", async () => {
    const id = await pdf();
    const created = made(await shareRecord(DRIVE, id, { title: "Trip notes" }));
    expect(created.serves).toBe("original");
    const file = await visitFile(created.linkToken);
    expect(file.status, file.raw).toBe(302);
    const location = new URL(file.headers["Location"]!);
    expect(location.pathname).toBe(`/${PDF_KEY}`);
    expect(location.searchParams.get("response-content-type")).toBe("application/pdf");
    expect(location.searchParams.get("response-content-disposition")).toMatch(
      /^inline; filename="Trip notes\.pdf"/,
    );
    // A file has nothing to show on the items page.
    expect((await visit(created.linkToken)).body["items"]).toEqual([]);
  });

  it.each([
    ["an SVG", "image/svg", "image/svg+xml", "drawing.svg"],
    ["an HTML file", "document/html", "text/html", "page.html"],
  ])(
    "from Drive downloads %s as an opaque file, so its script never runs on this origin",
    async (_, type, contentType, fileName) => {
      const id = await register(
        A,
        { type, contentType, contentHash: "4".repeat(64), sizeBytes: 2_000, fileName },
        DRIVE,
      );
      const created = made(await shareRecord(DRIVE, id, { serves: "original", title: fileName }));
      const file = await visitFile(created.linkToken);
      expect(file.status, file.raw).toBe(302);
      const location = new URL(file.headers["Location"]!);
      expect(location.searchParams.get("response-content-type")).toBe("application/octet-stream");
      expect(location.searchParams.get("response-content-disposition")).toMatch(
        new RegExp(`^attachment; filename="${fileName.replace(".", "\\.")}"`),
      );
    },
  );

  it("is listed by its record, and answers its source", async () => {
    const id = await pdf();
    made(await shareRecord(DRIVE, id));
    const listed = await callAs(DRIVE, A, "GET", `/data/public-shares?recordId=${id}`);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body["mayPublish"]).toBe(true);
    expect(listed.body["publicShares"]).toMatchObject([
      { source: { kind: "record", recordId: id }, serves: "original", title: "Beach" },
    ]);
    // Photos' list is Photos' own.
    expect((await call(A, "GET", "/data/public-shares")).body["publicShares"]).toEqual([]);
  });

  it("stops showing anything once its record is deleted", async () => {
    const id = await pdf();
    const created = made(await shareRecord(DRIVE, id));
    const deleted = await callAs(DRIVE, A, "DELETE", `/data/records/${id}`);
    expect(deleted.status, JSON.stringify(deleted.body)).toBeLessThan(300);
    const file = await visitFile(created.linkToken);
    expect(file.status).toBe(404);
    expect(file.raw).toContain("This link no longer shows anything.");
    expect(file.headers["X-Robots-Tag"]).toBe("noindex");
    expect(file.headers["Content-Type"]).toContain("text/html");
  });

  it("is refused for a child record, another user's record and a type the app cannot read", async () => {
    const { standIn } = await albumWithOnePhoto();
    expect((await shareRecord(DRIVE, standIn)).status).toBe(404);

    // Only B holds the PDF. (A record's id follows from its content, so a
    // photo both users hold has one id, and A's share of it is A's own.)
    const others = await pdf(B);
    expect((await shareRecord(DRIVE, others)).status).toBe(404);

    const id = await pdf();
    expect((await shareRecord(PHOTOS, id)).status).toBe(404);

    expect((await shareRecord(DRIVE, "not-an-id")).status).toBe(400);
    expect((await pg.query("SELECT * FROM public_sharing.public_shares")).rows).toEqual([]);
  });

  it("is refused for Drive once the admin-web switch is off", async () => {
    const id = await pdf();
    await pg.query("DELETE FROM public_sharing.app_capabilities WHERE app_id = $1", [DRIVE]);
    expect((await shareRecord(DRIVE, id)).status).toBe(403);
  });

  it.each(["archived", "restoring"] as const)(
    "is refused an original that is %s, and may still share the stand-in",
    async (state) => {
      const { original } = await albumWithOnePhoto();
      await markAvailability(ORIGINAL_KEY, state);
      const res = await shareRecord(DRIVE, original, { serves: "original" });
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain("Share the largest stand-in instead.");
      made(await shareRecord(DRIVE, original));
    },
  );

  it("answers archived for an original that archived after its link was made", async () => {
    const { original } = await albumWithOnePhoto();
    const created = made(await shareRecord(DRIVE, original, { serves: "original" }));
    await markAvailability(ORIGINAL_KEY, "archived");
    const file = await visitFile(created.linkToken);
    expect(file.status).toBe(409);
    expect(file.raw).toContain("This file is archived.");
    expect(file.raw).not.toContain(ORIGINAL_HASH);
  });

  it("tells a visitor a photo is still uploading, rather than gone", async () => {
    // Hashes of their own: a warm Lambda remembers a key once seen present.
    const original = await register(A, {
      type: "image/jpeg",
      contentType: "image/jpeg",
      contentHash: "5".repeat(64),
      sizeBytes: 3_000_000,
      fileName: "late.jpg",
      fidelity: 4000,
      metadata: { width: 4000, height: 3000 },
    });
    await register(A, {
      type: "image/avif",
      contentType: "image/avif",
      contentHash: "6".repeat(64),
      sizeBytes: 300_000,
      fileName: "late-2560.avif",
      parentId: original,
      standIn: { role: "smaller", fidelity: 2560 },
    });
    const created = made(await shareRecord(PHOTOS, original));
    s3Mock
      .on(HeadObjectCommand)
      .rejects(Object.assign(new Error("NotFound"), { name: "NotFound" }));
    const waiting = await visit(created.linkToken);
    expect(waiting.status, waiting.raw).toBe(200);
    expect(waiting.body["items"]).toEqual([]);
    expect(waiting.body["pending"]).toBe(1);

    const deleted = await call(A, "DELETE", `/data/records/${original}`);
    expect(deleted.status, JSON.stringify(deleted.body)).toBeLessThan(300);
    const gone = await visit(created.linkToken);
    expect(gone.body["items"]).toEqual([]);
    expect(gone.body["pending"]).toBe(0);
  });

  it("answers not uploaded for a file whose bytes are still on a device", async () => {
    // A hash of its own: a warm Lambda remembers a key once seen present.
    const id = await pdf(A, "9".repeat(64));
    const created = made(await shareRecord(DRIVE, id));
    s3Mock
      .on(HeadObjectCommand)
      .rejects(Object.assign(new Error("NotFound"), { name: "NotFound" }));
    const file = await visitFile(created.linkToken);
    expect(file.status).toBe(409);
    expect(file.raw).toContain("This file has not finished uploading.");
  });

  it("gives a label share no direct link, and an expired one the expiry", async () => {
    await albumWithOnePhoto();
    const album = await share();
    expect((await visitFile(album.linkToken)).status).toBe(404);

    const id = await pdf();
    const created = made(await shareRecord(DRIVE, id));
    await pg.query("UPDATE public_sharing.public_shares SET expires_at_ms = 1 WHERE id = $1", [
      created.id,
    ]);
    const file = await visitFile(created.linkToken);
    expect(file.status).toBe(410);
    expect(file.raw).toContain("This link has expired.");
  });
});
