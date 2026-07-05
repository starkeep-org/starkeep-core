/**
 * Regression: the app's first S3 write (putAppKeepFile) runs on the assumed
 * session of a *just-created* IAM role, so it can transiently fail
 * `InvalidAccessKeyId` until the new principal converges globally. It must
 * retry that (it previously had no retry wrapper at all, so a cold role failed
 * the whole install on the keep-file PutObject), while still surfacing genuine
 * non-retryable errors immediately.
 *
 * setTimeout is stubbed to fire immediately so the backoff loop doesn't add
 * real wall-clock delay to the test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const send = vi.fn();

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = send;
  },
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
  ListObjectsV2Command: class {},
  DeleteObjectsCommand: class {},
}));

import { putAppKeepFile } from "../src/s3";

const appCreds = {
  accessKeyId: "AK",
  secretAccessKey: "SK",
  sessionToken: "ST",
  expiration: new Date(Date.now() + 3600 * 1000),
};

function invalidAccessKeyId(): Error {
  // Shape the AWS SDK throws for a not-yet-recognized principal.
  const err = new Error(
    "The AWS Access Key Id you provided does not exist in our records.",
  );
  err.name = "InvalidAccessKeyId";
  return err;
}

beforeEach(() => {
  send.mockReset();
  // Collapse the retry backoff so the test runs instantly.
  vi.stubGlobal("setTimeout", (fn: () => void) => {
    fn();
    return 0 as unknown as NodeJS.Timeout;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("putAppKeepFile", () => {
  it("retries the keep-file PutObject through the fresh-role InvalidAccessKeyId window", async () => {
    // Fresh-role window: two rejections, then S3 recognizes the principal.
    send
      .mockRejectedValueOnce(invalidAccessKeyId())
      .mockRejectedValueOnce(invalidAccessKeyId())
      .mockResolvedValueOnce({});

    await expect(
      putAppKeepFile("starkeep", "photos", "starkeep-files-x", "us-east-1", appCreds),
    ).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(3);
    const cmd = send.mock.calls[0][0] as { input: { Bucket: string; Key: string } };
    expect(cmd.input).toMatchObject({
      Bucket: "starkeep-files-x",
      Key: "apps/photos/.keep",
    });
  });

  it("does not retry a genuine non-transient error", async () => {
    const err = new Error("The specified bucket does not exist");
    err.name = "NoSuchBucket";
    send.mockRejectedValue(err);

    await expect(
      putAppKeepFile("starkeep", "photos", "starkeep-files-x", "us-east-1", appCreds),
    ).rejects.toThrow(/does not exist/);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
