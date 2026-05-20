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
  await s3.send(
    new PutObjectCommand({
      Bucket: filesBucket,
      Key: `apps/${appId}/.keep`,
      Body: "",
    }),
  );
}

/** Upload the app's dist.zip to the artifacts bucket. */
export async function uploadAppBundle(
  _stackPrefix: string,
  appId: string,
  version: string,
  artifactsBucket: string,
  zipBuffer: Buffer,
  region: string,
  appCreds: AwsCredentials,
): Promise<void> {
  const s3 = makeS3Client(appCreds, region);
  await s3.send(
    new PutObjectCommand({
      Bucket: artifactsBucket,
      Key: `apps/${appId}/${version}/dist.zip`,
      Body: zipBuffer,
      ContentType: "application/zip",
    }),
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
