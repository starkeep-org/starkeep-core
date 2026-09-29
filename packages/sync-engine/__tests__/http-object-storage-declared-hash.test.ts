/**
 * Every presign the device uploader asks for carries the upload's SHA-256.
 *
 * The cloud pins that hash into the signed URL, so S3 checks the whole file
 * against it and keeps a whole-file checksum. A shared key names its own hash;
 * an app-syncable key does not, and without the declared hash the cloud now
 * refuses to sign it.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HttpObjectStorageAdapter } from "../src/transports/http-object-storage.js";

function fakeCloud() {
  const presigns: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/files/presign")) {
      presigns.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ url: "https://s3.example/put?sig=abc" });
    }
    if (url.startsWith("https://s3.example/")) {
      // Drain a streamed body, as S3 would.
      if (init?.body instanceof ReadableStream) await new Response(init.body).arrayBuffer();
      return new Response(null, { status: 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as unknown as typeof globalThis.fetch;
  const adapter = new HttpObjectStorageAdapter({
    baseUrl: "https://api.example/apps/notes/files",
    fetch: fetchImpl,
    signRequest: () => ({}),
  });
  return { adapter, presigns };
}

const hex = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const b64 = (data: Uint8Array) => createHash("sha256").update(data).digest("base64");

describe("the hash each presign declares", () => {
  it("is computed from the bytes for a buffered upload", async () => {
    const { adapter, presigns } = fakeCloud();
    const data = new TextEncoder().encode("an app's own file");
    await adapter.put("apps/notes/syncable/n1", data, { contentType: "text/plain" });
    expect(presigns).toEqual([{ key: "apps/notes/syncable/n1", contentType: "text/plain", contentHash: hex(data) }]);
  });

  it("is the caller's, when a buffered upload names one", async () => {
    const { adapter, presigns } = fakeCloud();
    const data = new TextEncoder().encode("bytes");
    await adapter.put("apps/notes/syncable/n2", data, { checksumSha256: b64(data) });
    expect(presigns[0]!.contentHash).toBe(hex(data));
  });

  it("is the expected hash for a streamed upload", async () => {
    const { adapter, presigns } = fakeCloud();
    const data = new TextEncoder().encode("streamed bytes");
    await adapter.putStream("apps/notes/syncable/n3", new Response(data).body!, {
      expectedSha256Hex: hex(data),
      sizeBytes: data.length,
    });
    expect(presigns[0]!.contentHash).toBe(hex(data));
  });
});
