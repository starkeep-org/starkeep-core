/**
 * `HttpObjectStorageAdapter.presignUploads` and `uploadPresigned` — the
 * uploader's two calls against the cloud data server.
 *
 * One request asks about a whole batch and signs every PUT, so the signed
 * path, the body shape and the answer order are the contract with
 * `POST /files/presign-batch`. The PUT then echoes the headers the server
 * bound into each signature, exactly as the single presign's PUT does.
 */
import { describe, expect, it } from "vitest";
import { MockObjectStorageAdapter } from "@starkeep/storage-adapter";
import { HttpObjectStorageAdapter } from "../src/transports/http-object-storage.js";
import { createUploadTarget, type UploadItem } from "../src/uploader.js";

const KEY_A = "shared/image/ab/" + "ab".repeat(32);
const KEY_B = "shared/image/cd/" + "cd".repeat(32);
const KEY_C = "shared/video/ef/" + "ef".repeat(32);

function fakeCloud(answers: unknown[]) {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    if (url.endsWith("/files/presign-batch")) {
      return new Response(JSON.stringify({ answers }), { status: 200 });
    }
    if (url.startsWith("https://s3.example/")) return new Response("", { status: 200 });
    throw new Error(`unexpected request: ${method} ${url}`);
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

function adapter(cloud: ReturnType<typeof fakeCloud>): HttpObjectStorageAdapter {
  return new HttpObjectStorageAdapter({
    baseUrl: "https://api.example/apps/starkeep-drive/files",
    fetch: cloud.fetchImpl,
    signRequest: (method, path) => ({ "x-starkeep-signature": `${method} ${path}` }),
  });
}

function item(key: string, overrides: Partial<UploadItem> = {}): UploadItem {
  return {
    file: {
      key,
      hlc: { wallTime: 1, counter: 0, nodeId: "P" },
      recordId: null,
      itemId: key,
      sizeBytes: 8,
      fileHash: key.split("/").pop()!,
      mimeType: "image/jpeg",
      tier: "fast",
    },
    expectedSha256Hex: key.split("/").pop()!,
    parts: false,
    ...overrides,
  };
}

const REPORT = {
  sinceMs: null,
  succeeded: { fast: { count: 0, bytes: 0 }, full: { count: 0, bytes: 0 } },
  failures: [],
  failureCount: 0,
  blockedNotHeld: 0,
  queue: { fast: 2, full: 1, blocked: 0 },
  state: "running" as const,
};

describe("presign batch", () => {
  it("asks once for the whole batch, signed over the batch route, with the report", async () => {
    const cloud = fakeCloud([
      { key: KEY_A, status: "present" },
      { key: KEY_B, status: "signed", url: "https://s3.example/b", checksumSha256: "bb==" },
      { key: KEY_C, status: "absent" },
    ]);
    const target = createUploadTarget(adapter(cloud));

    const answers = await target.prepare(
      [item(KEY_A), item(KEY_B), item(KEY_C, { parts: true })],
      REPORT,
    );

    expect(cloud.calls).toHaveLength(1);
    const call = cloud.calls[0]!;
    expect(call.url).toBe("https://api.example/apps/starkeep-drive/files/presign-batch");
    expect(call.headers["x-starkeep-signature"]).toBe("POST /files/presign-batch");
    expect(call.body).toEqual({
      items: [
        { key: KEY_A, contentType: "image/jpeg", contentHash: "ab".repeat(32), sizeBytes: 8 },
        { key: KEY_B, contentType: "image/jpeg", contentHash: "cd".repeat(32), sizeBytes: 8 },
        // Sent in parts, so the batch asks only whether the cloud holds it.
        {
          key: KEY_C,
          contentType: "image/jpeg",
          contentHash: "ef".repeat(32),
          sizeBytes: 8,
          sign: false,
        },
      ],
      report: REPORT,
    });
    expect(answers).toEqual([
      { status: "present" },
      { status: "signed", signed: { url: "https://s3.example/b", checksumSha256: "bb==" } },
      { status: "absent" },
    ]);
  });

  it("reads an answer for the wrong key as an error for that item", async () => {
    const cloud = fakeCloud([
      { key: KEY_B, status: "present" },
      { key: KEY_A, status: "present" },
    ]);
    const answers = await createUploadTarget(adapter(cloud)).prepare(
      [item(KEY_A), item(KEY_B)],
      REPORT,
    );
    expect(answers.map((a) => a.status)).toEqual(["error", "error"]);
  });

  it("throws when the request as a whole fails, so the uploader pauses", async () => {
    const fetchImpl = (async () =>
      new Response("busy", {
        status: 503,
        statusText: "Service Unavailable",
      })) as unknown as typeof globalThis.fetch;
    const remote = new HttpObjectStorageAdapter({
      baseUrl: "https://api.example/files",
      fetch: fetchImpl,
    });
    await expect(remote.presignUploads([{ key: KEY_A }])).rejects.toThrow(/failed: 503/);
  });
});

describe("presigned upload", () => {
  it("echoes every header the server bound into the signature, and presigns nothing itself", async () => {
    const cloud = fakeCloud([]);
    const remote = adapter(cloud);
    const local = new MockObjectStorageAdapter();
    await local.put(KEY_A, new Uint8Array(8));

    await remote.uploadPresigned(
      KEY_A,
      {
        url: "https://s3.example/a",
        checksumSha256: "aa==",
        storageClass: "STANDARD",
        tagging: { "starkeep:intent": "instant" },
      },
      local,
      { contentType: "image/jpeg", sizeBytes: 8 },
    );

    expect(cloud.calls.map((c) => c.url)).toEqual(["https://s3.example/a"]);
    expect(cloud.calls[0]!.method).toBe("PUT");
    expect(cloud.calls[0]!.headers).toMatchObject({
      "Content-Type": "image/jpeg",
      "x-amz-checksum-sha256": "aa==",
      "x-amz-storage-class": "STANDARD",
      "x-amz-tagging": "starkeep%3Aintent=instant",
      "Content-Length": "8",
    });
  });

  it("sends from a file URI when the source names one and the adapter can", async () => {
    const cloud = fakeCloud([]);
    const sent: string[] = [];
    const remote = new HttpObjectStorageAdapter({
      baseUrl: "https://api.example/apps/starkeep-drive/files",
      fetch: cloud.fetchImpl,
      uploadFile: async (fileUri, url) => {
        sent.push(`${fileUri} -> ${url}`);
        return { status: 200, body: "" };
      },
    });
    const local = new MockObjectStorageAdapter();
    (local as unknown as { localFileUriFor: (key: string) => string }).localFileUriFor = () =>
      "content://media/1";

    await remote.uploadPresigned(
      KEY_A,
      { url: "https://s3.example/a", checksumSha256: "aa==" },
      local,
      { contentType: "image/jpeg", sizeBytes: 8, expectedSha256Hex: "ab".repeat(32) },
    );

    expect(sent).toEqual(["content://media/1 -> https://s3.example/a"]);
    expect(cloud.calls).toEqual([]);
  });

  it("goes up in parts only above the threshold, with the ports, from a file URI", () => {
    const remote = new HttpObjectStorageAdapter({
      baseUrl: "https://api.example/files",
      uploadFile: async () => ({ status: 200, body: "" }),
      hashFileParts: async () => ({ sizeBytes: 0, sha256Hex: "", partSha256Hex: [] }),
      uploadFileRange: async () => ({ status: 200, body: "", etag: "e" }),
    });
    const withUri = new MockObjectStorageAdapter();
    (withUri as unknown as { localFileUriFor: () => string }).localFileUriFor = () => "file:///v";
    const withoutUri = new MockObjectStorageAdapter();

    expect(remote.sendsInParts(KEY_C, 65 * 1024 * 1024, withUri)).toBe(true);
    expect(remote.sendsInParts(KEY_C, 63 * 1024 * 1024, withUri)).toBe(false);
    expect(remote.sendsInParts(KEY_C, 65 * 1024 * 1024, withoutUri)).toBe(false);
  });
});
