// S3 round trip against a running AWS Emulator, using @aws-sdk/client-s3 v3.
//
// run.sh starts the emulator and sets the environment the emulator's
// "point your SDK" guide asks for before this process starts:
//   AWS_ENDPOINT_URL             https://127.0.0.1:<port>
//   AWS_SHARED_CREDENTIALS_FILE  ~/.aws/emulator/<port>/emulator_credentials
//   AWS_CONFIG_FILE              ~/.aws/emulator/<port>/config
//   NODE_EXTRA_CA_CERTS          ~/.aws/emulator/<port>/ca.pem (Node reads it at startup only)
//   AWS_REGION                   us-east-1
// and unsets every other credential source (static keys, profile, web identity, container),
// so the SDK's default chain picks up the keys this emulator run generated.
//
// Prints one JSON line on stdout: {"ok":true|false, ...}. Exit code 0 only when ok.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";

const endpoint = process.env.AWS_ENDPOINT_URL ?? "";

// Refuse to run against anything that is not a loopback emulator, so a missing
// variable can never send these requests to real AWS.
if (!/^https:\/\/127\.0\.0\.1:\d+\/?$/.test(endpoint)) {
  console.log(
    JSON.stringify({
      ok: false,
      error: `AWS_ENDPOINT_URL must be https://127.0.0.1:<port>, got "${endpoint}"`,
    }),
  );
  process.exit(1);
}
// Everything other than the emulator's credentials file that the SDK's default chain
// could use. If that file were missing, the chain would fall through to these.
const otherCredentialSources = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
];
for (const name of otherCredentialSources) {
  if (process.env[name]) {
    console.log(
      JSON.stringify({
        ok: false,
        error: `${name} is set; unset it so only the emulator's own keys are used`,
      }),
    );
    process.exit(1);
  }
}

const credentialsFile = process.env.AWS_SHARED_CREDENTIALS_FILE ?? "";
if (!existsSync(credentialsFile)) {
  console.log(
    JSON.stringify({
      ok: false,
      error: `AWS_SHARED_CREDENTIALS_FILE "${credentialsFile}" does not exist`,
    }),
  );
  process.exit(1);
}

const s3 = new S3Client({
  endpoint,
  region: process.env.AWS_REGION ?? "us-east-1",
  // The emulator only accepts path-style addressing. With a 127.0.0.1 endpoint
  // the SDK already picks path style; setting it makes the requirement explicit.
  forcePathStyle: true,
  // The guide's JavaScript v3 setting for host-prefixed operations (not used by
  // the S3 calls below, kept so the recipe is copyable to other services).
  disableHostPrefix: true,
});

const bucket = `spike-runtime-${Date.now()}-${randomBytes(3).toString("hex")}`;
const key = "probe/round-trip.bin";
const body = randomBytes(64 * 1024);
const steps = [];

async function step(name, fn) {
  const started = performance.now();
  const result = await fn();
  steps.push({ step: name, ms: Math.round(performance.now() - started) });
  return result;
}

try {
  await step("CreateBucket", () => s3.send(new CreateBucketCommand({ Bucket: bucket })));
  await step("PutObject", () =>
    s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body })),
  );
  const got = await step("GetObject", async () => {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return Buffer.from(await res.Body.transformToByteArray());
  });
  if (!got.equals(body)) {
    throw new Error(
      `GetObject returned ${got.length} bytes that do not match the ${body.length} bytes put`,
    );
  }
  const listed = await step("ListObjectsV2", () =>
    s3.send(new ListObjectsV2Command({ Bucket: bucket })),
  );
  const keys = (listed.Contents ?? []).map((o) => o.Key);
  if (keys.length !== 1 || keys[0] !== key) {
    throw new Error(`ListObjectsV2 returned ${JSON.stringify(keys)}, expected ["${key}"]`);
  }
  await step("DeleteObject", () => s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })));
  const after = await step("ListObjectsV2 (after delete)", () =>
    s3.send(new ListObjectsV2Command({ Bucket: bucket })),
  );
  if ((after.Contents ?? []).length !== 0) {
    throw new Error(`object still listed after DeleteObject: ${JSON.stringify(after.Contents)}`);
  }
  await step("DeleteBucket", () => s3.send(new DeleteBucketCommand({ Bucket: bucket })));
  console.log(JSON.stringify({ ok: true, bucket, bytes: body.length, steps }));
} catch (err) {
  console.log(
    JSON.stringify({
      ok: false,
      error: `${err.name ?? "Error"}: ${err.message}`,
      httpStatus: err.$metadata?.httpStatusCode,
      cause: err.cause?.code ?? err.code,
      steps,
    }),
  );
  process.exitCode = 1;
}
