import {
  LambdaClient,
  PutFunctionConcurrencyCommand,
  DeleteFunctionConcurrencyCommand,
  GetFunctionConcurrencyCommand,
} from "@aws-sdk/client-lambda";
import type { STSCredentials } from "./cognito-auth";

function makeClient(creds: STSCredentials, region: string): LambdaClient {
  return new LambdaClient({
    region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

function stageFromBucket(s3Bucket: string): string {
  const match = s3Bucket.match(/^starkeep-files-(.+)$/);
  return match?.[1] ?? "dev";
}

function functionNames(stackPrefix: string, stage: string): string[] {
  return [
    `${stackPrefix}-api-${stage}`,
    `${stackPrefix}-photos-api-${stage}`,
  ];
}

/** Returns true if any stack Lambda currently has reserved concurrency set to 0. */
export async function isShutOff(
  creds: STSCredentials,
  region: string,
  stackPrefix: string,
  s3Bucket: string,
): Promise<boolean> {
  const client = makeClient(creds, region);
  const stage = stageFromBucket(s3Bucket);
  const names = functionNames(stackPrefix, stage);

  const results = await Promise.allSettled(
    names.map((name) =>
      client.send(new GetFunctionConcurrencyCommand({ FunctionName: name })),
    ),
  );

  return results.some(
    (r) => r.status === "fulfilled" && r.value.ReservedConcurrentExecutions === 0,
  );
}

/** Sets reserved concurrency to 0 on all stack Lambdas, blocking all invocations. */
export async function shutOffLambdas(
  creds: STSCredentials,
  region: string,
  stackPrefix: string,
  s3Bucket: string,
): Promise<void> {
  const client = makeClient(creds, region);
  const stage = stageFromBucket(s3Bucket);
  await Promise.all(
    functionNames(stackPrefix, stage).map((name) =>
      client.send(
        new PutFunctionConcurrencyCommand({ FunctionName: name, ReservedConcurrentExecutions: 0 }),
      ),
    ),
  );
}

/** Removes reserved concurrency limit, restoring normal Lambda scaling. */
export async function restoreLambdas(
  creds: STSCredentials,
  region: string,
  stackPrefix: string,
  s3Bucket: string,
): Promise<void> {
  const client = makeClient(creds, region);
  const stage = stageFromBucket(s3Bucket);
  await Promise.all(
    functionNames(stackPrefix, stage).map((name) =>
      client.send(new DeleteFunctionConcurrencyCommand({ FunctionName: name })),
    ),
  );
}
