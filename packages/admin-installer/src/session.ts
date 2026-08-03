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
 * take 30–90s to propagate, during which AssumeRole returns AccessDenied
 * with a "not authorized" message. Retry that specific failure mode with
 * bounded backoff. Worst-case total: ~3 minutes (~30 attempts × 10s cap),
 * matching the DSQL connect retry budget. Other failures throw immediately
 * so a real policy bug isn't masked.
 */
const ASSUME_ROLE_MAX_ATTEMPTS = 30;
const ASSUME_ROLE_INITIAL_DELAY_MS = 1000;
const ASSUME_ROLE_MAX_DELAY_MS = 10_000;

function isPropagationError(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  const message = (err as { message?: string })?.message ?? "";
  return name === "AccessDenied" || /not authorized to perform: sts:AssumeRole/i.test(message);
}

async function assumeRoleWithRetry(
  client: STSClient,
  roleArn: string,
  sessionPrefix: string,
  maxAttempts: number,
): Promise<AwsCredentials> {
  let delay = ASSUME_ROLE_INITIAL_DELAY_MS;
  const start = Date.now();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await client.send(
        new AssumeRoleCommand({
          RoleArn: roleArn,
          RoleSessionName: `${sessionPrefix}-${Date.now()}`,
          DurationSeconds: 3600,
        }),
      );
      const c = result.Credentials;
      if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
        throw new Error(`AssumeRole(${roleArn}) returned incomplete credentials`);
      }
      if (attempt > 1) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`[diag] sts:AssumeRole ${roleArn}: succeeded on attempt ${attempt} after ${elapsed}s`);
      }
      return {
        accessKeyId: c.AccessKeyId,
        secretAccessKey: c.SecretAccessKey,
        sessionToken: c.SessionToken,
        expiration: c.Expiration ?? new Date(Date.now() + 3600 * 1000),
      };
    } catch (err) {
      if (!isPropagationError(err) || attempt === maxAttempts) throw err;
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(
        `[diag] sts:AssumeRole ${roleArn}: attempt ${attempt} AccessDenied at ${elapsed}s, retrying in ${(delay / 1000).toFixed(1)}s`,
      );
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, ASSUME_ROLE_MAX_DELAY_MS);
    }
  }
  throw new Error("unreachable");
}

export interface RoleChainOptions {
  /**
   * Credentials to make the *first* hop with.
   *
   * The installer runs as a spawned CLI whose federated session arrives as
   * `AWS_*` env vars, so the default (ambient) is right there. A long-lived
   * server process is the opposite case: admin-web holds no AWS identity of
   * its own and receives the operator's session per request, so it must state
   * the base explicitly rather than inherit whatever the machine happens to
   * have configured — which would silently chain from the developer's personal
   * profile.
   */
  readonly baseCredentials?: AwsCredentials;
  /** Also explicit for the server case, where `AWS_REGION` may be unset. */
  readonly region?: string;
  /** Shows up in CloudTrail as the assumed-role session name. */
  readonly sessionPrefix?: string;
  /**
   * Attempts per hop before an AccessDenied is taken at face value.
   *
   * The default budget exists for one situation: a role minted seconds ago
   * whose trust policy has not propagated. Chaining into a role that has
   * existed since bootstrap is not that situation — there a denial is a real
   * policy answer, and spending three minutes rediscovering it just leaves
   * whoever is waiting looking at a spinner. Callers in that position pass 1.
   */
  readonly assumeAttempts?: number;
}

export async function roleChain(
  roleArns: string[],
  options: RoleChainOptions = {},
): Promise<AwsCredentials> {
  if (roleArns.length === 0) throw new Error("roleChain requires at least one role ARN");

  const sessionPrefix = options.sessionPrefix ?? "starkeep-install";
  const maxAttempts = options.assumeAttempts ?? ASSUME_ROLE_MAX_ATTEMPTS;
  let credentials: AwsCredentials | undefined = options.baseCredentials;

  for (const roleArn of roleArns) {
    const client = credentials
      ? new STSClient({
          ...(options.region ? { region: options.region } : {}),
          credentials: {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
            sessionToken: credentials.sessionToken,
          },
        })
      : new STSClient(options.region ? { region: options.region } : {});

    credentials = await assumeRoleWithRetry(client, roleArn, sessionPrefix, maxAttempts);
  }

  return credentials!;
}
