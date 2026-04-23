import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import type { STSCredentials } from "./cognito-auth";

function makeS3Client(credentials: STSCredentials, region: string) {
  return new S3Client({
    region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
  });
}

export async function s3PutObject(
  bucket: string,
  key: string,
  bodyBase64: string,
  contentType: string,
  credentials: STSCredentials,
  region: string,
): Promise<void> {
  const body = Buffer.from(bodyBase64, "base64");
  const s3 = makeS3Client(credentials, region);
  await s3.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
  );
}

export async function s3GetObjectText(
  bucket: string,
  key: string,
  credentials: STSCredentials,
  region: string,
): Promise<string> {
  const s3 = makeS3Client(credentials, region);
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return res.Body!.transformToString("utf-8");
}
