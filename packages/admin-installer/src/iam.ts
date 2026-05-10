/**
 * IAM operations for app role lifecycle.
 * All calls run from the Manager session credentials.
 */

import {
  IAMClient,
  CreateRoleCommand,
  DeleteRoleCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
} from "@aws-sdk/client-iam";
import type { AwsCredentials } from "./session.js";
import {
  buildRuntimePolicy,
  buildTempInstallPolicy,
  buildTempUninstallPolicy,
  buildTempInstallCloudDataServerPolicy,
} from "./temp-policies.js";
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
  permissionsBoundaryArn: string;
  sharedTypeAccess: SharedTypeAccess[];
  canIngestUnknown: boolean;
  canPromoteFromUnknown: boolean;
  brokerPower: boolean;
  managerCreds: AwsCredentials;
}

export async function createAppRole(input: CreateAppRoleInput): Promise<string> {
  const {
    stackPrefix, appId, accountId, permissionsBoundaryArn,
    sharedTypeAccess, canIngestUnknown, canPromoteFromUnknown,
    brokerPower, managerCreds,
  } = input;
  const iam = makeIamClient(managerCreds);
  const roleName = `${stackPrefix}-app-${appId}-role`;

  const expanded = expandWildcard(sharedTypeAccess);
  const typeIds = expanded.map((e) => e.typeId);
  const hasWriteAccess = expanded.some((e) => e.access === "readwrite");

  await iam.send(
    new CreateRoleCommand({
      RoleName: roleName,
      AssumeRolePolicyDocument: JSON.stringify({
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
      PermissionsBoundary: permissionsBoundaryArn,
      Tags: [{ Key: "starkeep:appId", Value: appId }, { Key: "starkeep:managed", Value: "true" }],
    }),
  );

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
  managerCreds: AwsCredentials,
): Promise<void> {
  const iam = makeIamClient(managerCreds);
  await iam.send(
    new PutRolePolicyCommand({
      RoleName: `${stackPrefix}-app-${appId}-role`,
      PolicyName: "temp-install",
      PolicyDocument: buildTempInstallPolicy(stackPrefix, appId, accountId),
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
  managerCreds: AwsCredentials,
): Promise<void> {
  const iam = makeIamClient(managerCreds);
  await iam.send(
    new PutRolePolicyCommand({
      RoleName: `${stackPrefix}-app-${appId}-role`,
      PolicyName: "temp-uninstall",
      PolicyDocument: buildTempUninstallPolicy(stackPrefix, appId, accountId),
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
 * Attach the wider temp-install policy used only by the cloud-data-server
 * built-in app's install/update — covers DSQL cluster management, S3 bucket
 * creation, API Gateway management, and the foundational Lambda + log group.
 */
export async function attachTempInstallCloudDataServerPolicy(
  stackPrefix: string,
  accountId: string,
  managerCreds: AwsCredentials,
): Promise<void> {
  const iam = makeIamClient(managerCreds);
  await iam.send(
    new PutRolePolicyCommand({
      RoleName: `${stackPrefix}-app-cloud-data-server-role`,
      PolicyName: "temp-install-cloud-data-server",
      PolicyDocument: buildTempInstallCloudDataServerPolicy(stackPrefix, accountId),
    }),
  );
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
