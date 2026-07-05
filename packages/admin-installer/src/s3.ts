/**
 * S3 operations for app install/uninstall.
 * All calls use the app-session credentials, not Manager's.
 */

import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import type { AwsCredentials } from "./session";
import { retryOnAccessDenied } from "./retry-on-access-denied";

function makeS3Client(creds: AwsCredentials, region: string): S3Client {
  return new S3Client({
    region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

/** Create the zero-byte sentinel that marks the app's S3 presence. */
export async function putAppKeepFile(
  _stackPrefix: string,
  appId: string,
  filesBucket: string,
  region: string,
  appCreds: AwsCredentials,
): Promise<void> {
  const s3 = makeS3Client(appCreds, region);
  const key = `apps/${appId}/.keep`;
  // First S3 call made on the freshly-created app role's assumed-session creds
  // (the orchestrator assumes the role immediately after createAppRole). A
  // just-created IAM principal isn't recognized globally for a few seconds, so
  // this can fail `InvalidAccessKeyId` until it converges — same eventual-
  // consistency class as the PutRolePolicy propagation retryOnAccessDenied
  // already absorbs. Without this wrapper a cold role fails the whole install
  // on the very first data-plane write (the bundle upload below is already
  // wrapped; this one wasn't, and that was the gap).
  await retryOnAccessDenied(
    `s3:PutObject ${filesBucket}/${key}`,
    async () => {
      await s3.send(
        new PutObjectCommand({
          Bucket: filesBucket,
          Key: key,
          Body: "",
        }),
      );
    },
    { maxAttempts: 30, maxDelayMs: 10_000 },
  );
}

/**
 * Upload the app's dist.zip to the artifacts bucket at the well-known
 * "latest" key. Pulumi's `aws.lambda.Function` reads the exact same key
 * as `s3Key`, so the upload-then-pulumi-up sequence in installApp is
 * self-consistent. The bucket is versioned (see bootstrap ArtifactsBucket),
 * so previous bundles remain retrievable via S3 versioning if a rollback
 * is ever needed — we don't currently key by version in the path.
 */
export async function uploadAppBundle(
  _stackPrefix: string,
  appId: string,
  artifactsBucket: string,
  zipBuffer: Buffer,
  region: string,
  appCreds: AwsCredentials,
): Promise<void> {
  const s3 = makeS3Client(appCreds, region);
  const key = `apps/${appId}/latest/dist.zip`;
  // Runs immediately after attachTempInstallInfraPolicy; S3 authz propagation
  // after PutRolePolicy can take minutes (see probePulumiStateBucket comment).
  await retryOnAccessDenied(
    `s3:PutObject ${artifactsBucket}/${key}`,
    async () => {
      await s3.send(
        new PutObjectCommand({
          Bucket: artifactsBucket,
          Key: key,
          Body: zipBuffer,
          ContentType: "application/zip",
        }),
      );
    },
    { maxAttempts: 30, maxDelayMs: 10_000 },
  );
}

async function deletePrefix(
  s3: S3Client,
  bucket: string,
  prefix: string,
): Promise<void> {
  let continuationToken: string | undefined;
  do {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    const keys = (list.Contents ?? []).map((obj) => ({ Key: obj.Key! }));
    if (keys.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys, Quiet: true },
        }),
      );
    }
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);
}

/** Delete all objects under apps/<appId>/ in the files bucket (app-owned data). */
export async function deleteAppFilesObjects(
  appId: string,
  filesBucket: string,
  region: string,
  appCreds: AwsCredentials,
): Promise<void> {
  const s3 = makeS3Client(appCreds, region);
  await deletePrefix(s3, filesBucket, `apps/${appId}/`);
}

/**
 * Delete all objects under apps/<appId>/ in the artifacts bucket. Run under
 * install-infra credentials — per-app roles no longer carry artifacts-bucket
 * access in their permanent boundary; artifact lifecycle is install-time
 * concern owned by install-infra.
 */
export async function deleteAppArtifactsObjects(
  appId: string,
  artifactsBucket: string,
  region: string,
  infraCreds: AwsCredentials,
): Promise<void> {
  const s3 = makeS3Client(infraCreds, region);
  await deletePrefix(s3, artifactsBucket, `apps/${appId}/`);
}
