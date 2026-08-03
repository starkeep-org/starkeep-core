/**
 * The presigned PUT must bind checksum, storage class and tagging into the
 * signature *as signed headers*.
 *
 * Presigning makes no network calls, so this runs offline — which matters,
 * because the failure it guards is otherwise invisible until a real S3 PUT.
 * The S3 presigner's default is to hoist every `x-amz-*` header into the query
 * string, leaving `SignedHeaders=host`. An uploader that then sends the values
 * as headers — which is exactly what these options ask of it — gets:
 *
 *   403 AccessDenied: There were headers present in the request which were not
 *   signed — x-amz-checksum-sha256, x-amz-storage-class
 *
 * That message names permissions, so it reads as an IAM gap and sends whoever
 * hits it into the policies. It is not: it is `signableHeaders` without
 * `unhoistableHeaders`. Every shared-blob upload in cloud sync goes through
 * this URL, so getting it wrong breaks sync completely while every install and
 * every policy check still passes.
 */

import { describe, it, expect } from "vitest";
import { S3ObjectStorageAdapter } from "../src/adapter.js";

const adapter = new S3ObjectStorageAdapter({
  bucketName: "test-bucket",
  region: "us-east-2",
  credentials: {
    accessKeyId: "AKIAFAKEFAKEFAKEFAKE",
    secretAccessKey: "fakefakefakefakefakefakefakefakefakefake",
  },
});

const PINNED = ["x-amz-checksum-sha256", "x-amz-storage-class", "x-amz-tagging"];

async function presign(): Promise<URL> {
  const url = await adapter.getSignedPutUrl!("shared/image/aa/deadbeef", {
    expiresIn: 3600,
    checksumSha256: "3q2+7w==",
    storageClass: "INTELLIGENT_TIERING",
    tagging: { "starkeep:intent": "keep" },
  });
  return new URL(url);
}

describe("getSignedPutUrl pins its options into the signature", () => {
  it("signs checksum, storage class and tagging as headers", async () => {
    const signed = ((await presign()).searchParams.get("X-Amz-SignedHeaders") ?? "").split(";");
    for (const header of PINNED) {
      expect(signed, `${header} must be a signed header`).toContain(header);
    }
  });

  it("does not hoist them into the query string instead", async () => {
    // The distinction is the whole bug: hoisted means present-but-unsigned
    // from S3's point of view once the uploader also sends the header.
    const params = [...(await presign()).searchParams.keys()].map((k) => k.toLowerCase());
    for (const header of PINNED) {
      expect(params, `${header} must not be hoisted to a query param`).not.toContain(header);
    }
  });

  it("signs only host when no options are pinned", async () => {
    // The complement: nothing extra is demanded of an uploader that was given
    // nothing to send, so a plain presigned PUT keeps working.
    const url = new URL(await adapter.getSignedPutUrl!("shared/image/aa/deadbeef", {}));
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  });
});
