/**
 * `HttpObjectStorageAdapter.putFromFileUri` — the presign/upload/confirm wiring.
 *
 * Every header here is inside the presigned URL's signature, so getting one
 * wrong does not degrade anything: S3 answers `SignatureDoesNotMatch` and the
 * transfer fails. That is worth pinning in a test rather than discovering on a
 * handset, which is the only other place this code runs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FileUriTransferRefused } from "@starkeep/storage-adapter";
import { HttpObjectStorageAdapter, type UploadFile } from "../src/transports/http-object-storage.js";

const KEY = "shared/video/ab/" + "ab".repeat(32);
const URI = "content://media/external/video/media/42";

interface Sent {
  fileUri: string;
  url: string;
  init: { method: string; headers: Record<string, string> };
}

/**
 * A cloud that signs uploads. `presign` is what the server would answer for a
 * content-addressed key: it derives the checksum from the key itself, so the
 * uploader has no say in what it is allowed to write there.
 */
function fakeCloud(options: { presign?: Record<string, unknown>; confirmStatus?: number } = {}) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
    if (url.endsWith("/files/presign")) {
      return new Response(
        JSON.stringify(
          options.presign ?? {
            url: "https://s3.example/put?sig=abc",
            checksumSha256: "qqqq",
            storageClass: "STANDARD",
            tagging: { "starkeep:intent": "instant" },
          },
        ),
        { status: 200 },
      );
    }
    if (url.endsWith("/files/confirm")) {
      return new Response("", { status: options.confirmStatus ?? 200 });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

function adapterWith(
  uploadFile: UploadFile | undefined,
  cloud: ReturnType<typeof fakeCloud>,
): HttpObjectStorageAdapter {
  return new HttpObjectStorageAdapter({
    baseUrl: "https://api.example/apps/starkeep-drive/files",
    fetch: cloud.fetchImpl,
    signRequest: (method, path) => ({ "x-starkeep-signature": `${method} ${path}` }),
    ...(uploadFile ? { uploadFile } : {}),
  });
}

let sent: Sent[];
let uploadFile: UploadFile;

beforeEach(() => {
  sent = [];
  uploadFile = async (fileUri, url, init) => {
    sent.push({ fileUri, url, init: { method: init.method, headers: init.headers } });
    return { status: 200, body: "" };
  };
});

describe("uploading from a file URI", () => {
  it("presigns, sends the file, and confirms", async () => {
    const cloud = fakeCloud();
    const adapter = adapterWith(uploadFile, cloud);

    await adapter.putFromFileUri!(KEY, URI, { contentType: "video/mp4", sizeBytes: 24_498_741 });

    expect(cloud.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://api.example/apps/starkeep-drive/files/presign",
      "POST https://api.example/apps/starkeep-drive/files/confirm",
    ]);
    expect(cloud.calls[0]!.body).toEqual({ key: KEY, contentType: "video/mp4" });
    expect(sent).toEqual([
      {
        fileUri: URI,
        url: "https://s3.example/put?sig=abc",
        init: {
          method: "PUT",
          headers: {
            "Content-Type": "video/mp4",
            "x-amz-checksum-sha256": "qqqq",
            "x-amz-storage-class": "STANDARD",
            "x-amz-tagging": "starkeep%3Aintent=instant",
          },
        },
      },
    ]);
  });

  // The uploader takes the length from the file. A second one here would be a
  // duplicate header on a signed request.
  it("sends no Content-Length of its own", async () => {
    const cloud = fakeCloud();
    await adapterWith(uploadFile, cloud).putFromFileUri!(KEY, URI, { sizeBytes: 24_498_741 });
    expect(Object.keys(sent[0]!.init.headers)).not.toContain("Content-Length");
  });

  it("has no putFromFileUri at all without an uploader", () => {
    expect(adapterWith(undefined, fakeCloud()).putFromFileUri).toBeUndefined();
  });
});

describe("what may and may not be sent unverified", () => {
  // Nothing in JS sees a byte on this path, so the pinned checksum is the only
  // thing that can verify them. Without one, uploading anyway would be the
  // worst of the available behaviours — it looks like a success.
  it("refuses when a digest was asked for and the server pinned none", async () => {
    const cloud = fakeCloud({ presign: { url: "https://s3.example/put?sig=abc" } });
    const adapter = adapterWith(uploadFile, cloud);

    await expect(
      adapter.putFromFileUri!(KEY, URI, { expectedSha256Hex: "ab".repeat(32) }),
    ).rejects.toBeInstanceOf(FileUriTransferRefused);
    // Before any bytes moved, which is what makes the caller's fallback free.
    expect(sent).toEqual([]);
  });

  it("uploads unpinned bytes when no digest was asked for", async () => {
    const cloud = fakeCloud({ presign: { url: "https://s3.example/put?sig=abc" } });
    await adapterWith(uploadFile, cloud).putFromFileUri!(KEY, URI);
    expect(sent).toHaveLength(1);
  });
});

describe("failures", () => {
  it("reports S3's own explanation of a rejected PUT", async () => {
    const cloud = fakeCloud();
    const adapter = adapterWith(
      async () => ({
        status: 403,
        body: "<?xml version='1.0'?>\n<Error><Code>SignatureDoesNotMatch</Code></Error>",
      }),
      cloud,
    );

    const failure = adapter.putFromFileUri!(KEY, URI);
    await expect(failure).rejects.toThrow(/403.*SignatureDoesNotMatch/s);
    // Not a refusal: bytes may have moved, so the caller must not retry this
    // through the stream path.
    await expect(failure).rejects.not.toBeInstanceOf(FileUriTransferRefused);
  });

  it("fails the upload when the server will not sign it", async () => {
    const cloud = fakeCloud();
    const refusing = {
      ...cloud,
      fetchImpl: (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch,
    };
    await expect(adapterWith(uploadFile, refusing).putFromFileUri!(KEY, URI)).rejects.toThrow(
      /presign PUT .* failed: 403/,
    );
    expect(sent).toEqual([]);
  });

  // The cloud data server has no `/files/confirm` route today, so this is the
  // live behaviour and not a hypothetical: every upload logs this warning. The
  // blob is durably in S3 either way and the server reconciles lazily on pull,
  // which is why a failed confirm must not fail the transfer.
  it("warns but succeeds when confirm 404s", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cloud = fakeCloud({ confirmStatus: 404 });
      await expect(adapterWith(uploadFile, cloud).putFromFileUri!(KEY, URI)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("confirm"));
    } finally {
      warn.mockRestore();
    }
  });
});
