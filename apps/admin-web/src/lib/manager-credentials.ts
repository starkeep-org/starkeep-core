/**
 * Manager credentials for one privileged SSM call, from the operator's session.
 *
 * The credentials that arrive in a request body are the admin-app role, which
 * deliberately holds no SSM grant beyond the Pulumi passphrase. Writing
 * credentials, device records and the deployment's settings is Manager's job
 * (see `data-roles-and-permissions.md`), which keeps the federated human from
 * being a superuser over those prefixes. So a route does the same admin-app →
 * Manager hop the installer does.
 *
 * The role ARN is read from `~/.starkeep/config.json` rather than taken from
 * the request body: a role ARN is the one input that decides *which* identity
 * does a privileged write, and it is already on disk.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";
import type { AwsCredentials } from "@starkeep/admin-installer/app-creds";
// A subpath: `session` imports nothing but the STS client.
import { roleChain } from "@starkeep/admin-installer/session";
import type { STSCredentials } from "./cognito-auth";

export interface StarkeepConfig {
  stackPrefix?: string;
  accountId?: string;
  managerRoleArn?: string;
  publicBaseUrl?: string;
  apiGatewayUrl?: string;
}

export function readStarkeepConfig(): StarkeepConfig {
  const path = join(starkeepDir(), "config.json");
  if (!existsSync(path)) {
    throw new Error("~/.starkeep/config.json not found — complete the cloud setup first");
  }
  return JSON.parse(readFileSync(path, "utf-8")) as StarkeepConfig;
}

/**
 * The two credential shapes differ by one field: admin-web carries `expiration`
 * as the ISO string it came off the wire as, the installer as a `Date`. Mapped
 * explicitly rather than cast, so a future field added to either side is a
 * compile error here instead of an `undefined` at runtime.
 */
function toAwsCreds(c: STSCredentials): AwsCredentials {
  return {
    accessKeyId: c.accessKeyId,
    secretAccessKey: c.secretAccessKey,
    sessionToken: c.sessionToken,
    expiration: new Date(c.expiration),
  };
}

/**
 * Assume Manager for one call. Same fallback as the uninstall CLI for configs
 * written before `managerRoleArn` was recorded. `sessionPrefix` names the act
 * in CloudTrail.
 */
export async function managerCredentials(
  config: StarkeepConfig,
  operatorCreds: STSCredentials,
  region: string,
  sessionPrefix: string,
): Promise<AwsCredentials> {
  const managerRoleArn =
    config.managerRoleArn ??
    (config.accountId && config.stackPrefix
      ? `arn:aws:iam::${config.accountId}:role/${config.stackPrefix}-manager-role`
      : null);
  if (!managerRoleArn) {
    throw new Error(
      "~/.starkeep/config.json has no managerRoleArn (and no accountId to derive it from) — complete the cloud setup first",
    );
  }

  return roleChain([managerRoleArn], {
    baseCredentials: toAwsCreds(operatorCreds),
    region,
    sessionPrefix,
    // No propagation retry: Manager has existed since bootstrap, so a denial
    // here is a real answer (usually an expired sign-in) and the operator is
    // watching a spinner while we decide that.
    assumeAttempts: 1,
  });
}
