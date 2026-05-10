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

    const sessionName = `starkeep-install-${Date.now()}`;
    const result = await client.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: sessionName,
        DurationSeconds: 3600,
      }),
    );

    const c = result.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
      throw new Error(`AssumeRole(${roleArn}) returned incomplete credentials`);
    }
    credentials = {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      expiration: c.Expiration ?? new Date(Date.now() + 3600 * 1000),
    };
  }

  return credentials!;
}
