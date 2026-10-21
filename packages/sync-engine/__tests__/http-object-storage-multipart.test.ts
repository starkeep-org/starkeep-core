/**
 * `HttpObjectStorageAdapter.putFromFileUri` above the multipart threshold.
 *
 * The cloud here is a model of the two multipart routes and of S3 behind them:
 * S3 holds each upload's parts and refuses a completion whose ETags or
 * checksums disagree with what it stored, as the real one does. The file is a
 * model too: its digests are synthetic, so no test holds 64 MB.
 *
 * What is pinned: only missing parts go up, an aborted attempt keeps its
 * finished parts, the whole-file hash gates the upload, and every refusal that
 * means "start over" drops the session.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  ChecksumMismatchError,
  MULTIPART_PART_BYTES,
  MULTIPART_THRESHOLD_BYTES,
  partChecksumBase64,
  type FilePartDigests,
} from "@starkeep/storage-adapter";
import {
  HttpObjectStorageAdapter,
  inMemoryMultipartSessions,
  type HashFileParts,
  type MultipartSessionStore,
  type UploadFileRange,
} from "../src/transports/http-object-storage.js";

const HASH = "ab".repeat(32);
const KEY = `shared/u1/video/ab/${HASH}`;
const URI = "content://media/external/video/media/42";
const SIZE = 4 * MULTIPART_PART_BYTES + 5;
const digit = (n: number) => String(n % 10).repeat(64);
const DIGESTS: FilePartDigests = {
  sha256Hex: HASH,
  partSha256Hex: [1, 2, 3, 4, 5].map(digit),
  sizeBytes: SIZE,
};

interface Part {
  readonly etag: string;
  readonly checksum: string;
}

function model() {
  const uploads = new Map<string, Map<number, Part>>();
  const completed: Array<{ key: string; parts: number[] }> = [];
  const routes: string[] = [];
  const presigns: Array<{ uploadId?: string; parts: number[] }> = [];
  const checksums: string[] = [];
  let nextUpload = 1;

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const route = url.replace("https://api.example/apps/starkeep-drive", "");
    routes.push(route);
    if (route === "/files/multipart/presign") {
      const parts = body.parts as Array<{ partNumber: number; checksumSha256: string }>;
      checksums.push(...parts.map((p) => p.checksumSha256));
      presigns.push({
        ...(body.uploadId ? { uploadId: body.uploadId as string } : {}),
        parts: parts.map((p) => p.partNumber),
      });
      const uploadId = (body.uploadId as string | undefined) ?? `UP-${nextUpload++}`;
      if (!uploads.has(uploadId) && !body.uploadId) uploads.set(uploadId, new Map());
      return Response.json({
        key: body.key,
        uploadId,
        parts: parts.map((p) => ({
          partNumber: p.partNumber,
          url: `https://s3.example/part?u=${uploadId}&n=${p.partNumber}&c=${encodeURIComponent(p.checksumSha256)}`,
        })),
      });
    }
    if (route === "/files/multipart/complete") {
      const stored = uploads.get(body.uploadId as string);
      if (!stored) return Response.json({ code: "NoSuchUpload" }, { status: 409 });
      const parts = body.parts as Array<{
        partNumber: number;
        etag: string;
        checksumSha256: string;
      }>;
      const bad = parts.some((p) => {
        const s = stored.get(p.partNumber);
        return !s || s.etag !== p.etag || s.checksum !== p.checksumSha256;
      });
      if (bad) return Response.json({ code: "InvalidPart" }, { status: 409 });
      uploads.delete(body.uploadId as string);
      completed.push({ key: body.key as string, parts: parts.map((p) => p.partNumber) });
      return Response.json({ key: body.key });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as unknown as typeof globalThis.fetch;

  const sent: Array<{ partNumber: number; offset: number; length: number }> = [];
  let failAfter = Infinity;
  const uploadFileRange: UploadFileRange = async (fileUri, range, url, init) => {
    expect(fileUri).toBe(URI);
    const u = new URL(url);
    const uploadId = u.searchParams.get("u")!;
    const partNumber = Number(u.searchParams.get("n"));
    // S3 checks the header against the checksum the signature pinned.
    expect(init.headers["x-amz-checksum-sha256"]).toBe(u.searchParams.get("c"));
    if (sent.length >= failAfter) throw new Error("background window closed");
    const stored = uploads.get(uploadId);
    if (!stored) {
      return { status: 404, body: "<Error><Code>NoSuchUpload</Code></Error>", etag: null };
    }
    sent.push({ partNumber, ...range });
    const etag = `"${uploadId}-${partNumber}"`;
    stored.set(partNumber, { etag, checksum: init.headers["x-amz-checksum-sha256"]! });
    return { status: 200, body: "", etag };
  };

  return {
    fetchImpl,
    uploadFileRange,
    uploads,
    completed,
    routes,
    presigns,
    checksums,
    sent,
    failAfterParts: (n: number) => void (failAfter = n),
  };
}

let cloud: ReturnType<typeof model>;
let sessions: MultipartSessionStore;
let digests: FilePartDigests;
const hashFileParts: HashFileParts = async (uri, partBytes) => {
  expect(uri).toBe(URI);
  expect(partBytes).toBe(MULTIPART_PART_BYTES);
  return digests;
};

function adapter(): HttpObjectStorageAdapter {
  return new HttpObjectStorageAdapter({
    baseUrl: "https://api.example/apps/starkeep-drive/files",
    fetch: cloud.fetchImpl,
    uploadFile: async () => {
      throw new Error("a large file must not go up as a single PUT");
    },
    hashFileParts,
    uploadFileRange: cloud.uploadFileRange,
    multipartSessions: sessions,
  });
}

const put = (a = adapter()) =>
  a.putFromFileUri!(KEY, URI, {
    contentType: "video/mp4",
    sizeBytes: SIZE,
    expectedSha256Hex: HASH,
  });

beforeEach(() => {
  cloud = model();
  sessions = inMemoryMultipartSessions();
  digests = DIGESTS;
});

describe("a file above the multipart threshold", () => {
  it("goes up as fixed-size parts, each pinned to its digest, then completes", async () => {
    await put();
    expect(cloud.presigns).toEqual([{ parts: [1, 2, 3, 4, 5] }]);
    expect(cloud.sent).toEqual([
      { partNumber: 1, offset: 0, length: MULTIPART_PART_BYTES },
      { partNumber: 2, offset: MULTIPART_PART_BYTES, length: MULTIPART_PART_BYTES },
      { partNumber: 3, offset: 2 * MULTIPART_PART_BYTES, length: MULTIPART_PART_BYTES },
      { partNumber: 4, offset: 3 * MULTIPART_PART_BYTES, length: MULTIPART_PART_BYTES },
      { partNumber: 5, offset: 4 * MULTIPART_PART_BYTES, length: 5 },
    ]);
    expect(cloud.completed).toEqual([{ key: KEY, parts: [1, 2, 3, 4, 5] }]);
    expect(await sessions.get(KEY)).toBeNull();
  });

  it("resumes an aborted upload, sending only the parts S3 lacks", async () => {
    cloud.failAfterParts(2);
    await expect(put()).rejects.toThrow(/background window/);
    expect((await sessions.get(KEY))?.uploadId).toBe("UP-1");

    cloud.failAfterParts(Infinity);
    await put();
    expect(cloud.presigns[1]).toEqual({ uploadId: "UP-1", parts: [3, 4, 5] });
    expect(cloud.sent.map((s) => s.partNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(cloud.completed).toHaveLength(1);
  });

  // The only link between the parts S3 checks and the key: the same read
  // produced both, and the whole must be what the key names.
  it("refuses to upload a file whose whole-file hash is not the key's", async () => {
    digests = { ...DIGESTS, sha256Hex: "cd".repeat(32) };
    await expect(put()).rejects.toBeInstanceOf(ChecksumMismatchError);
    expect(cloud.routes).toEqual([]);
  });

  it("refuses a file whose size disagrees with the record", async () => {
    digests = { ...DIGESTS, sizeBytes: SIZE - 1 };
    await expect(put()).rejects.toThrow(/says/);
    expect(cloud.routes).toEqual([]);
  });

  it("starts a new upload when the file's parts changed since the session began", async () => {
    cloud.failAfterParts(2);
    await expect(put()).rejects.toThrow();
    cloud.failAfterParts(Infinity);
    digests = { ...DIGESTS, partSha256Hex: [6, 7, 8, 9, 0].map(digit) };
    await put();
    expect(cloud.presigns[1]).toEqual({ parts: [1, 2, 3, 4, 5] });
    expect(cloud.completed).toHaveLength(1);
  });

  it("drops a session S3 no longer holds, and the next attempt starts over", async () => {
    cloud.failAfterParts(1);
    await expect(put()).rejects.toThrow();
    cloud.uploads.clear(); // the 7-day lifecycle rule aborted it
    cloud.failAfterParts(Infinity);
    await expect(put()).rejects.toThrow(/no longer holds/);
    expect(await sessions.get(KEY)).toBeNull();
    await put();
    expect(cloud.presigns.at(-1)).toEqual({ parts: [1, 2, 3, 4, 5] });
    expect(cloud.completed).toHaveLength(1);
  });

  it("drops the session when S3 refuses the completion", async () => {
    cloud.failAfterParts(4);
    await expect(put()).rejects.toThrow();
    cloud.failAfterParts(Infinity);
    // A remembered ETag S3 does not hold: the completion must be refused.
    const session = (await sessions.get(KEY))!;
    await sessions.set(KEY, { ...session, etags: { ...session.etags, "4": '"forged"' } });
    await expect(put()).rejects.toThrow(/409/);
    expect(await sessions.get(KEY)).toBeNull();
  });

  it("pins each part's digest in S3's base64 form", async () => {
    await put();
    expect(cloud.checksums).toEqual(DIGESTS.partSha256Hex.map(partChecksumBase64));
  });
});

describe("a file at or below the threshold", () => {
  it("keeps the single PUT even when the ports are supplied", async () => {
    const singles: string[] = [];
    const a = new HttpObjectStorageAdapter({
      baseUrl: "https://api.example/apps/starkeep-drive/files",
      fetch: (async () =>
        Response.json({
          url: "https://s3.example/put",
          checksumSha256: "qqqq",
        })) as unknown as typeof fetch,
      uploadFile: async (uri) => {
        singles.push(uri);
        return { status: 200, body: "" };
      },
      hashFileParts,
      uploadFileRange: cloud.uploadFileRange,
    });
    await a.putFromFileUri!(KEY, URI, {
      sizeBytes: MULTIPART_THRESHOLD_BYTES,
      expectedSha256Hex: HASH,
    });
    expect(singles).toEqual([URI]);
    expect(cloud.sent).toEqual([]);
  });
});
