/**
 * Diagnostic helpers for install-time IAM state. These exist to answer
 * "what does AWS actually think this role can do right now?" without
 * relying on the operator running CLI commands at the right moment.
 *
 * All calls use Manager credentials (iam:* lives there), not the app
 * session — so they work even when the app role's effective permissions
 * are the very thing under investigation.
 */

import {
  IAMClient,
  GetRoleCommand,
  ListRolePoliciesCommand,
  ListAttachedRolePoliciesCommand,
} from "@aws-sdk/client-iam";
import {
  STSClient,
  GetCallerIdentityCommand,
} from "@aws-sdk/client-sts";
import type { AwsCredentials } from "./session";

function iamClient(creds: AwsCredentials): IAMClient {
  return new IAMClient({
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

function stsClient(creds: AwsCredentials): STSClient {
  return new STSClient({
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

/**
 * Log the role's permissions boundary ARN and the names of its inline +
 * attached managed policies. Answers "is this the role we think it is,
 * and is the temp-install policy actually attached?"
 */
export async function logAppRoleSnapshot(
  roleName: string,
  managerCreds: AwsCredentials,
): Promise<void> {
  const iam = iamClient(managerCreds);

  const [role, inline, attached] = await Promise.all([
    iam.send(new GetRoleCommand({ RoleName: roleName })),
    iam.send(new ListRolePoliciesCommand({ RoleName: roleName })),
    iam.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName })),
  ]);

  const boundaryArn = role.Role?.PermissionsBoundary?.PermissionsBoundaryArn ?? "(none)";
  const inlineNames = inline.PolicyNames ?? [];
  const attachedArns = (attached.AttachedPolicies ?? []).map((p) => p.PolicyArn ?? "?");

  console.log(`[diag] role ${roleName}:`);
  console.log(`[diag]   permissions boundary: ${boundaryArn}`);
  console.log(`[diag]   inline policies:      [${inlineNames.join(", ")}]`);
  console.log(`[diag]   attached managed:     [${attachedArns.join(", ")}]`);
  // Per-policy JSON dumps removed — too noisy for routine runs. Re-enable
  // via `aws iam get-role-policy` ad hoc when investigating policy drift.
}

/**
 * Log the caller identity of an STS session — i.e., the assumed-role ARN
 * AWS is actually seeing. Confirms the app session is what we think.
 */
export async function logCallerIdentity(
  label: string,
  creds: AwsCredentials,
): Promise<void> {
  const sts = stsClient(creds);
  try {
    const res = await sts.send(new GetCallerIdentityCommand({}));
    console.log(`[diag] ${label} caller identity: ${res.Arn} (account ${res.Account})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[diag] ${label} caller identity: <error: ${msg}>`);
  }
}

// SimulatePrincipalPolicy-based perm checks removed — manager role lacks the
// IAM permission to call it and the snapshot dump above is enough signal.
