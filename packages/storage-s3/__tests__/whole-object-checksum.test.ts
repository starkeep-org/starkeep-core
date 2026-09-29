/**
 * Every object this adapter writes carries a whole-object SHA-256.
 *
 * A node proves the cloud holds a file by comparing the SHA-256 S3 reports
 * against the record's content hash. S3 reports a whole-object SHA-256 only
 * for a single-request upload; a multipart upload stores a composite over the
 * parts, which proves nothing, and a file uploaded that way could never be
 * freed from any device. So every write is one request, and every request
 * carries the hash.
 *
 * The S3 client is replaced with a recorder: what matters is the command the
 * adapter sends, and presigning aside, sending is its only contact with S3.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { MAX_SINGLE_PUT_BYTES, S3ObjectStorageAdapter } from "../src/adapter.js";

function recording() {
  const adapter = new S3ObjectStorageAdapter({
    bucketName: "test-bucket",
    region: "us-east-2",
    credentials: { accessKeyId: "AKIAFAKE", secretAccessKey: "fake" },
  });
  const sent: Array<Record<string, unknown>> = [];
  const send = vi.fn(async (command: unknown) => {
    expect(command).toBeInstanceOf(PutObjectCommand);
    const input = { ...(command as PutObjectCommand).input } as Record<string, unknown>;
    // Drain a streamed body, as S3 would, so the test can see what went up.
    const body = input.Body as unknown;
    if (body && typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
      const chunks: Buffer[] = [];
      for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
      input.Body = Buffer.concat(chunks);
    }
    sent.push(input);
    return {};
  });
  (adapter as unknown as { client: { send: typeof send } }).client = { send };
  return { adapter, sent };
}

const bytes = (n: number) => Buffer.alloc(n, 7);
const b64 = (data: Buffer) => createHash("sha256").update(data).digest("base64");
const hex = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const stream = (data: Buffer) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      // Several chunks, so the hashing sees a stream rather than one buffer.
      for (let i = 0; i < data.length; i += 1000) controller.enqueue(data.subarray(i, i + 1000));
      controller.close();
    },
  });

describe("put", () => {
  it("sends one request with the caller's checksum", async () => {
    const { adapter, sent } = recording();
    const data = bytes(10);
    await adapter.put("shared/image/aa/x", data, { checksumSha256: b64(data) });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.ChecksumSHA256).toBe(b64(data));
  });

  it("computes the checksum when the caller gives none", async () => {
    const { adapter, sent } = recording();
    const data = bytes(10);
    await adapter.put("apps/notes/syncable/x", data);
    expect(sent[0]!.ChecksumSHA256).toBe(b64(data));
  });

  // The old threshold sent anything past 5 MB as a multipart upload with no
  // whole-object checksum at all.
  it("sends a body past the old 5 MB multipart threshold as one request with its checksum", async () => {
    const { adapter, sent } = recording();
    const data = bytes(6 * 1024 * 1024);
    await adapter.put("shared/image/bb/y", data);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.ChecksumSHA256).toBe(b64(data));
  });
});

describe("putStream", () => {
  it("streams a known length in one request, checked against the expected hash", async () => {
    const { adapter, sent } = recording();
    const data = bytes(7 * 1024 * 1024);
    await adapter.putStream("shared/video/cc/z", stream(data), {
      sizeBytes: data.length,
      expectedSha256Hex: hex(data),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ ContentLength: data.length, ChecksumSHA256: b64(data) });
    expect((sent[0]!.Body as Buffer).equals(data)).toBe(true);
  });

  it("asks the SDK for a whole-object SHA-256 when the length is known and the hash is not", async () => {
    const { adapter, sent } = recording();
    const data = bytes(4096);
    await adapter.putStream("apps/notes/syncable/q", stream(data), { sizeBytes: data.length });
    expect(sent[0]).toMatchObject({ ContentLength: data.length, ChecksumAlgorithm: "SHA256" });
    expect(sent[0]!.ChecksumSHA256).toBeUndefined();
  });

  it("spools an unknown length, then sends it in one request with the hash it computed", async () => {
    const { adapter, sent } = recording();
    const data = bytes(12_345);
    await adapter.putStream("apps/notes/syncable/r", stream(data));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ ContentLength: data.length, ChecksumSHA256: b64(data) });
    expect((sent[0]!.Body as Buffer).equals(data)).toBe(true);
  });

  it("refuses an unknown-length stream that hashes to something other than expected, sending nothing", async () => {
    const { adapter, sent } = recording();
    await expect(
      adapter.putStream("shared/image/dd/s", stream(bytes(100)), { expectedSha256Hex: "0".repeat(64) }),
    ).rejects.toThrow(/hash to/);
    expect(sent).toEqual([]);
  });

  it("refuses more than one request can carry, before sending", async () => {
    const { adapter, sent } = recording();
    await expect(
      adapter.putStream("shared/video/ee/t", stream(bytes(10)), { sizeBytes: MAX_SINGLE_PUT_BYTES + 1 }),
    ).rejects.toThrow(/at most/);
    expect(sent).toEqual([]);
  });
});
