/**
 * The presigned multipart trio a device's resumable upload rides on.
 *
 * Each part's PUT must carry its SHA-256 as a *signed header*, for the same
 * reason the whole-object presign does (see presign-signed-headers.test.ts):
 * a hoisted checksum fails at S3 as an access error, and an unsigned one is a
 * header the uploader may drop. The create and complete calls are checked as
 * the commands the adapter sends.
 */
import { describe, expect, it, vi } from "vitest";
import { CompleteMultipartUploadCommand, CreateMultipartUploadCommand } from "@aws-sdk/client-s3";
import { S3ObjectStorageAdapter } from "../src/adapter.js";

function adapterWith(send?: (command: unknown) => Promise<unknown>) {
  const adapter = new S3ObjectStorageAdapter({
    bucketName: "test-bucket",
    region: "us-east-2",
    credentials: {
      accessKeyId: "AKIAFAKEFAKEFAKEFAKE",
      secretAccessKey: "fakefakefakefakefakefakefakefakefakefake",
    },
  });
  if (send) (adapter as unknown as { client: { send: typeof send } }).client = { send };
  return adapter;
}

describe("getSignedUploadPartUrl", () => {
  it("signs the part's checksum as a header and names the upload and part", async () => {
    const url = new URL(
      await adapterWith().getSignedUploadPartUrl("shared/u/video/aa/k", "UP-1", 3, {
        checksumSha256: "3q2+7w==",
      }),
    );
    expect((url.searchParams.get("X-Amz-SignedHeaders") ?? "").split(";")).toContain(
      "x-amz-checksum-sha256",
    );
    const params = [...url.searchParams.keys()].map((k) => k.toLowerCase());
    expect(params).not.toContain("x-amz-checksum-sha256");
    expect(params.some((k) => k.startsWith("x-amz-sdk-checksum"))).toBe(false);
    expect(url.searchParams.get("uploadId")).toBe("UP-1");
    expect(url.searchParams.get("partNumber")).toBe("3");
  });
});

describe("createMultipartUpload", () => {
  it("asks for SHA-256 part checksums and fixes class, type and tags on the upload", async () => {
    const send = vi.fn(async () => ({ UploadId: "UP-9" }));
    const id = await adapterWith(send).createMultipartUpload("shared/u/video/aa/k", {
      contentType: "video/mp4",
      storageClass: "INTELLIGENT_TIERING",
      tagging: { "starkeep:intent": "archive" },
    });
    expect(id).toBe("UP-9");
    const command = send.mock.calls[0]![0] as CreateMultipartUploadCommand;
    expect(command).toBeInstanceOf(CreateMultipartUploadCommand);
    expect(command.input).toMatchObject({
      Key: "shared/u/video/aa/k",
      ChecksumAlgorithm: "SHA256",
      ContentType: "video/mp4",
      StorageClass: "INTELLIGENT_TIERING",
      Tagging: "starkeep%3Aintent=archive",
    });
  });

  it("refuses a response with no upload id rather than resuming nothing", async () => {
    await expect(adapterWith(async () => ({})).createMultipartUpload("k")).rejects.toThrow(
      /no upload id/,
    );
  });
});

describe("completeMultipartUpload", () => {
  it("lists every part with its ETag and checksum", async () => {
    const send = vi.fn(async () => ({}));
    await adapterWith(send).completeMultipartUpload("k", "UP-1", [
      { partNumber: 1, etag: '"e1"', checksumSha256: "c1==" },
      { partNumber: 2, etag: '"e2"', checksumSha256: "c2==" },
    ]);
    const command = send.mock.calls[0]![0] as CompleteMultipartUploadCommand;
    expect(command).toBeInstanceOf(CompleteMultipartUploadCommand);
    expect(command.input.UploadId).toBe("UP-1");
    expect(command.input.MultipartUpload?.Parts).toEqual([
      { PartNumber: 1, ETag: '"e1"', ChecksumSHA256: "c1==" },
      { PartNumber: 2, ETag: '"e2"', ChecksumSHA256: "c2==" },
    ]);
  });
});
