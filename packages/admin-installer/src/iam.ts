/**
 * IAM operations for app role lifecycle.
 * All calls run from the Manager session credentials.
 */

import {
  IAMClient,
  CreateRoleCommand,
  DeleteRoleCommand,
  GetRoleCommand,
  GetRolePolicyCommand,
  ListRolePoliciesCommand,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
  UpdateAssumeRolePolicyCommand,
  EntityAlreadyExistsException,
} from "@aws-sdk/client-iam";
import type { AwsCredentials } from "./session";
import {
  buildRuntimePolicy,
  buildTempInstallPolicy,
  buildTempUninstallPolicy,
  buildTempInstallCloudDataServerPolicy,
  buildTempInstallDdlPolicy,
} from "./temp-policies";
import type { SharedTypeAccess } from "@starkeep/admin-manifest";
import { CORE_TYPE_REGISTRY } from "@starkeep/admin-manifest";

function makeIamClient(creds: AwsCredentials): IAMClient {
  return new IAMClient({
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

function expandWildcard(access: SharedTypeAccess[]): SharedTypeAccess[] {
  const result: SharedTypeAccess[] = [];
  for (const entry of access) {
    if (entry.typeId === "*") {
      for (const typeId of CORE_TYPE_REGISTRY) {
        result.push({ ...entry, typeId });
      }
    } else {
      result.push(entry);
    }
  }
  return result;
}

export interface CreateAppRoleInput {
  stackPrefix: string;
  appId: string;
  accountId: string;
  /** Boundary ARN for ordinary per-app roles. */
  permissionsBoundaryArn: string;
  /**
   * Boundary ARN for the foundational app (cloud-data-server). Routed via
   * the magic-string check below so that no caller — third-party manifest or
   * future code path — can request this wider ceiling for any other app.
   */
  foundationalPermissionsBoundaryArn: string;
  sharedTypeAccess: SharedTypeAccess[];
  canIngestUnknown: boolean;
  canPromoteFromUnknown: boolean;
  brokerPower: boolean;
  managerCreds: AwsCredentials;
}

/**
 * The single app id permitted to use the foundational permissions boundary.
 * Cloud-data-server provisions the DSQL cluster, files bucket, and shared
 * API Gateway; it is always installed before any other app. Centralizing the
 * choice here (rather than letting callers pass the boundary they want) is
 * what guarantees a third-party app cannot escape the regular per-app
 * boundary even if a future code path forgets to enforce it.
 */
const FOUNDATIONAL_APP_ID = "cloud-data-server";

export async function createAppRole(input: CreateAppRoleInput): Promise<string> {
  const {
    stackPrefix, appId, accountId,
    permissionsBoundaryArn, foundationalPermissionsBoundaryArn,
    sharedTypeAccess, canIngestUnknown, canPromoteFromUnknown,
    brokerPower, managerCreds,
  } = input;
  const iam = makeIamClient(managerCreds);
  const roleName = `${stackPrefix}-app-${appId}-role`;

  const boundaryArn = appId === FOUNDATIONAL_APP_ID
    ? foundationalPermissionsBoundaryArn
    : permissionsBoundaryArn;

  const expanded = expandWildcard(sharedTypeAccess);
  const typeIds = expanded.map((e) => e.typeId);
  const hasWriteAccess = expanded.some((e) => e.access === "readwrite");

  const assumeRolePolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "lambda.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
      {
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${accountId}:role/${stackPrefix}-manager-role` },
        Action: "sts:AssumeRole",
      },
    ],
  });
  try {
    await iam.send(
      new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: assumeRolePolicy,
        PermissionsBoundary: boundaryArn,
        Tags: [{ Key: "starkeep:appId", Value: appId }, { Key: "starkeep:managed", Value: "true" }],
      }),
    );
  } catch (err) {
    if (!(err instanceof EntityAlreadyExistsException)) throw err;
    await iam.send(
      new UpdateAssumeRolePolicyCommand({
        RoleName: roleName,
        PolicyDocument: assumeRolePolicy,
      }),
    );
  }

  const runtimePolicy = buildRuntimePolicy(
    stackPrefix, appId, typeIds, hasWriteAccess, canIngestUnknown, canPromoteFromUnknown,
  );
  await iam.send(
    new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: "runtime",
      PolicyDocument: runtimePolicy,
    }),
  );

  if (brokerPower) {
    await iam.send(
      new PutRolePolicyCommand({
        RoleName: roleName,
        PolicyName: "broker-power",
        PolicyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "BrokerAssumeAppRoles",
              Effect: "Allow",
              Action: "sts:AssumeRole",
              Resource: `arn:aws:iam::${accountId}:role/${stackPrefix}-app-*`,
            },
          ],
        }),
      }),
    );
  }

  return `arn:aws:iam::${accountId}:role/${roleName}`;
}

export async function attachTempInstallPolicy(
  stackPrefix: string,
  appId: string,
  accountId: string,
  region: string,
  managerCreds: AwsCredentials,
): Promise<void> {
  const iam = makeIamClient(managerCreds);
  await iam.send(
    new PutRolePolicyCommand({
      RoleName: `${stackPrefix}-app-${appId}-role`,
      PolicyName: "temp-install",
      PolicyDocument: buildTempInstallPolicy(stackPrefix, appId, accountId, region),
    }),
  );
}

export async function detachTempInstallPolicy(
  stackPrefix: string,
  appId: string,
  managerCreds: AwsCredentials,
): Promise<void> {
  const iam = makeIamClient(managerCreds);
  await iam.send(
    new DeleteRolePolicyCommand({
      RoleName: `${stackPrefix}-app-${appId}-role`,
      PolicyName: "temp-install",
    }),
  );
}

export async function attachTempUninstallPolicy(
  stackPrefix: string,
  appId: string,
  accountId: string,
  region: string,
  managerCreds: AwsCredentials,
): Promise<void> {
  const iam = makeIamClient(managerCreds);
  await iam.send(
    new PutRolePolicyCommand({
      RoleName: `${stackPrefix}-app-${appId}-role`,
      PolicyName: "temp-uninstall",
      PolicyDocument: buildTempUninstallPolicy(stackPrefix, appId, accountId, region),
    }),
  );
}

export async function detachTempUninstallPolicy(
  stackPrefix: string,
  appId: string,
  managerCreds: AwsCredentials,
): Promise<void> {
  const iam = makeIamClient(managerCreds);
  await iam.send(
    new DeleteRolePolicyCommand({
      RoleName: `${stackPrefix}-app-${appId}-role`,
      PolicyName: "temp-uninstall",
    }),
  );
}

export async function attachTempInstallDdlPolicy(
  stackPrefix: string,
  appId: string,
  managerCreds: AwsCredentials,
): Promise<void> {
  const iam = makeIamClient(managerCreds);
  await iam.send(
    new PutRolePolicyCommand({
      RoleName: `${stackPrefix}-install-ddl-role`,
      PolicyName: `temp-install-ddl-${appId}`,
      PolicyDocument: buildTempInstallDdlPolicy(stackPrefix),
    }),
  );
}

export async function detachTempInstallDdlPolicy(
  stackPrefix: string,
  appId: string,
  managerCreds: AwsCredentials,
): Promise<void> {
  const iam = makeIamClient(managerCreds);
  await iam.send(
    new DeleteRolePolicyCommand({
      RoleName: `${stackPrefix}-install-ddl-role`,
      PolicyName: `temp-install-ddl-${appId}`,
    }),
  );
}

export async function deleteAppRole(
  stackPrefix: string,
  appId: string,
  managerCreds: AwsCredentials,
): Promise<void> {
  const iam = makeIamClient(managerCreds);
  await iam.send(
    new DeleteRoleCommand({ RoleName: `${stackPrefix}-app-${appId}-role` }),
  );
}

/**
 * Delete all inline policies from an app role then delete the role itself.
 * `DeleteRole` fails with DeleteConflict when inline policies are present,
 * so we list and remove them first.
 */
export async function deleteAppRoleWithPolicies(
  stackPrefix: string,
  appId: string,
  managerCreds: AwsCredentials,
): Promise<void> {
  const iam = makeIamClient(managerCreds);
  const roleName = `${stackPrefix}-app-${appId}-role`;

  const { PolicyNames = [] } = await iam.send(new ListRolePoliciesCommand({ RoleName: roleName }));
  for (const policyName of PolicyNames) {
    await iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }));
  }

  await iam.send(new DeleteRoleCommand({ RoleName: roleName }));
}

/** Returns a canonical, key-sorted JSON string for deterministic comparison. */
function canonicalJson(obj: unknown): string {
  if (Array.isArray(obj)) return `[${obj.map(canonicalJson).join(",")}]`;
  if (obj !== null && typeof obj === "object") {
    const pairs = Object.keys(obj as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((obj as Record<string, unknown>)[k])}`);
    return `{${pairs.join(",")}}`;
  }
  return JSON.stringify(obj);
}

/**
 * Attach the wider temp-install policy used only by the cloud-data-server
 * built-in app's install/update — covers DSQL cluster management, S3 bucket
 * creation, API Gateway management, and the foundational Lambda + log group.
 *
 * Returns true if PutRolePolicy was actually called (policy was new or changed),
 * false if the existing policy was already identical and the call was skipped.
 * Callers should add an IAM propagation wait when this returns true.
 */
export async function attachTempInstallCloudDataServerPolicy(
  stackPrefix: string,
  accountId: string,
  region: string,
  managerCreds: AwsCredentials,
): Promise<boolean> {
  const iam = makeIamClient(managerCreds);
  const roleName = `${stackPrefix}-app-cloud-data-server-role`;
  const policyName = "temp-install-cloud-data-server";
  const desiredDocument = buildTempInstallCloudDataServerPolicy(stackPrefix, accountId, region);

  // Skip PutRolePolicy if the live policy content is identical to what we'd
  // set. Calling PutRolePolicy — even with the same document — resets IAM's
  // per-service propagation cache (Lambda, CUR, S3, …), forcing a full
  // re-propagation delay on every install attempt. Skipping preserves the
  // already-propagated state from the previous run.
  try {
    const existing = await iam.send(new GetRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }));
    if (existing.PolicyDocument) {
      const currentDoc = JSON.parse(decodeURIComponent(existing.PolicyDocument));
      const desiredDoc = JSON.parse(desiredDocument);
      if (canonicalJson(currentDoc) === canonicalJson(desiredDoc)) {
        console.log("temp-install-cloud-data-server policy unchanged; skipping PutRolePolicy (preserves IAM propagation)");
        return false;
      }
    }
  } catch {
    // Policy doesn't exist yet or GetRolePolicy failed — fall through to PutRolePolicy.
  }

  await iam.send(
    new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: policyName,
      PolicyDocument: desiredDocument,
    }),
  );
  return true;
}

export async function detachTempInstallCloudDataServerPolicy(
  stackPrefix: string,
  managerCreds: AwsCredentials,
): Promise<void> {
  const iam = makeIamClient(managerCreds);
  await iam.send(
    new DeleteRolePolicyCommand({
      RoleName: `${stackPrefix}-app-cloud-data-server-role`,
      PolicyName: "temp-install-cloud-data-server",
    }),
  );
}

/**
 * Re-apply the standard trust policy to an existing app role.
 *
 * Trust policies pin the principal to the role's unique RoleId at the moment
 * they're set, not by ARN. If the manager role is ever deleted + recreated
 * (e.g. bootstrap stack rebuilt), its RoleId changes and any app role's
 * trust policy is left pointing at the dead RoleId — assume-role denies.
 *
 * Calling this idempotently on every install re-resolves the manager-role
 * ARN to its current RoleId, healing that drift. Cheap and safe to do
 * regardless.
 */
export async function updateAppRoleTrustPolicy(
  stackPrefix: string,
  appId: string,
  accountId: string,
  managerCreds: AwsCredentials,
): Promise<void> {
  const iam = makeIamClient(managerCreds);
  await iam.send(
    new UpdateAssumeRolePolicyCommand({
      RoleName: `${stackPrefix}-app-${appId}-role`,
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
          {
            Effect: "Allow",
            Principal: { AWS: `arn:aws:iam::${accountId}:role/${stackPrefix}-manager-role` },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    }),
  );
}

/** True if the app role exists in IAM. */
export async function appRoleExists(
  stackPrefix: string,
  appId: string,
  managerCreds: AwsCredentials,
): Promise<boolean> {
  const iam = makeIamClient(managerCreds);
  try {
    await iam.send(new GetRoleCommand({ RoleName: `${stackPrefix}-app-${appId}-role` }));
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === "NoSuchEntityException") return false;
    throw err;
  }
}
