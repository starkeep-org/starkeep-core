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
function fakeCloud(options: { presign?: Record<string, unknown> } = {}) {
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
    // No `/files/confirm` branch. An unknown route throws below, which is what
    // makes the "never calls a confirm endpoint" test bite: a reintroduced call
    // fails loudly here instead of being quietly answered by a fake no real
    // server matches.
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
  it("presigns and sends the file, and asks the server nothing else", async () => {
    const cloud = fakeCloud();
    const adapter = adapterWith(uploadFile, cloud);

    await adapter.putFromFileUri!(KEY, URI, { contentType: "video/mp4", sizeBytes: 24_498_741 });

    // Exactly one call. A `POST /files/confirm` used to follow every upload and
    // no server ever implemented it, so each transfer spent a signed round trip
    // to be told 404 and warn about it. The assertion is the whole call list
    // rather than "presign was called", because the defect was an *extra* call
    // and a positive assertion cannot see one.
    expect(cloud.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://api.example/apps/starkeep-drive/files/presign",
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

  // The route never existed on any real server — only the testkit's fake cloud
  // answered it — so a 404 was the live behaviour on every upload and the
  // adapter warned once per blob. Nothing consumed the result: the record type
  // it claimed to flip appears nowhere, and the cloud tracks availability from
  // S3 events instead. Pinned as an absence because a call that costs a round
  // trip and buys nothing is easy to reintroduce.
  it("never calls a confirm endpoint", async () => {
    const cloud = fakeCloud();
    await adapterWith(uploadFile, cloud).putFromFileUri!(KEY, URI);
    expect(cloud.calls.some((c) => c.url.endsWith("/files/confirm"))).toBe(false);
  });
});
