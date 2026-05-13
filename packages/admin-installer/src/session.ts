/**
 * STS role-chain helper.
 *
 * Assumes a sequence of roles in order, returning the leaf credentials.
 * Used for the admin-app → Manager → installed-app role chain.
 */

import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
}

/**
 * IAM is eventually consistent: a freshly-created role's trust policy can
 * take several seconds to propagate, during which AssumeRole returns
 * AccessDenied with a "not authorized" message. Retry that specific failure
 * mode with bounded backoff (~30s total worst case). Other failures throw
 * immediately so a real policy bug isn't masked.
 */
const ASSUME_ROLE_MAX_ATTEMPTS = 8;
const ASSUME_ROLE_INITIAL_DELAY_MS = 1000;
const ASSUME_ROLE_MAX_DELAY_MS = 5000;

function isPropagationError(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  const message = (err as { message?: string })?.message ?? "";
  return name === "AccessDenied" || /not authorized to perform: sts:AssumeRole/i.test(message);
}

async function assumeRoleWithRetry(
  client: STSClient,
  roleArn: string,
): Promise<AwsCredentials> {
  let delay = ASSUME_ROLE_INITIAL_DELAY_MS;
  for (let attempt = 1; attempt <= ASSUME_ROLE_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await client.send(
        new AssumeRoleCommand({
          RoleArn: roleArn,
          RoleSessionName: `starkeep-install-${Date.now()}`,
          DurationSeconds: 3600,
        }),
      );
      const c = result.Credentials;
      if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
        throw new Error(`AssumeRole(${roleArn}) returned incomplete credentials`);
      }
      return {
        accessKeyId: c.AccessKeyId,
        secretAccessKey: c.SecretAccessKey,
        sessionToken: c.SessionToken,
        expiration: c.Expiration ?? new Date(Date.now() + 3600 * 1000),
      };
    } catch (err) {
      if (!isPropagationError(err) || attempt === ASSUME_ROLE_MAX_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, ASSUME_ROLE_MAX_DELAY_MS);
    }
  }
  throw new Error("unreachable");
}

export async function roleChain(roleArns: string[]): Promise<AwsCredentials> {
  if (roleArns.length === 0) throw new Error("roleChain requires at least one role ARN");

  let credentials: AwsCredentials | undefined;

  for (const roleArn of roleArns) {
    const client = credentials
      ? new STSClient({
          credentials: {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
            sessionToken: credentials.sessionToken,
          },
        })
      : new STSClient({});

    credentials = await assumeRoleWithRetry(client, roleArn);
  }

  return credentials!;
}
