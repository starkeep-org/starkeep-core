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

/** Delete all objects under apps/<appId>/ in both files and artifacts buckets. */
export async function deleteAppObjects(
  appId: string,
  filesBucket: string,
  artifactsBucket: string,
  region: string,
  appCreds: AwsCredentials,
): Promise<void> {
  const s3 = makeS3Client(appCreds, region);
  const prefix = `apps/${appId}/`;

  for (const bucket of [filesBucket, artifactsBucket]) {
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
}
