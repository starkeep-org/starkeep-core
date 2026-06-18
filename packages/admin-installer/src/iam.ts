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
  buildTempInstallInfraPolicy,
  buildTempUninstallInfraPolicy,
  buildTempInstallCloudDataServerPolicy,
  buildTempInstallDdlPolicy,
} from "./temp-policies";
import type { FileAccess } from "@starkeep/admin-manifest";
import { APP_GRANTABLE_CATEGORIES, typeCategory } from "@starkeep/protocol-primitives";

function makeIamClient(creds: AwsCredentials): IAMClient {
  return new IAMClient({
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

/**
 * The distinct categories implied by a manifest's fileAccess, for the
 * category-granular S3 IAM ceiling (D3). Drive (fileAccessAll) gets the
 * `shared/*` ceiling instead (handled in buildRuntimePolicy), but we still
 * pass every grantable category for completeness.
 */
function categoriesOf(fileAccess: FileAccess[]): string[] {
  const set = new Set<string>();
  for (const entry of fileAccess) {
    for (const type of entry.types) {
      const category = typeCategory(type);
      if (category !== "other") set.add(category);
    }
  }
  return [...set];
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
  /**
   * Boundary ARN for the User-Data-Owner app (Starkeep Drive). Routed via the
   * same magic-string check below so only the `starkeep-drive` app id can claim
   * the cross-cutting `shared/*` ceiling.
   */
  userDataOwnerPermissionsBoundaryArn: string;
  fileAccess: FileAccess[];
  fileAccessAll: boolean;
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

/**
 * The single app id permitted to use the user-data-owner permissions boundary.
 * Starkeep Drive owns the cross-cutting `shared/*` write ceiling that powers all
 * shared-record sync. Centralizing the choice here (rather than letting callers
 * pass the boundary they want) guarantees a third-party app cannot escape the
 * regular per-app boundary even if a future code path forgets to enforce it.
 */
export const USER_DATA_OWNER_APP_ID = "starkeep-drive";

/**
 * The local-data-server's built-in file-watcher identity. This is a
 * *local-only* identity and an immutable `origin_app_id` data tag: records the
 * watcher creates are shared records that sync to the cloud via the Starkeep
 * Drive channel under Drive's role, carrying `origin_app_id = "local-watcher"`.
 * There is no dedicated cloud write-role for it (the retired `local-data-sync`
 * cloud identity). It is reserved here only so no third-party app can claim the
 * name and impersonate watcher-originated data.
 */
export const LOCAL_WATCHER_APP_ID = "local-watcher";

/**
 * App ids that only built-in installs may claim. Third-party installs are
 * rejected on these so no manifest can impersonate cloud-data-server, Starkeep
 * Drive (the User-Data-Owner), or the local watcher. Built-in install paths opt
 * out of this guard explicitly (see `installApp`'s `allowReservedAppId`).
 * `local-data-sync` is the retired cloud sync identity — kept reserved so the
 * name cannot be reclaimed.
 */
export const RESERVED_APP_IDS: ReadonlySet<string> = new Set([
  FOUNDATIONAL_APP_ID,
  USER_DATA_OWNER_APP_ID,
  LOCAL_WATCHER_APP_ID,
  "local-data-sync",
]);

/**
 * Reject reserved built-in app ids for third-party installs. Format validity
 * is a separate concern (`assertCloudInstallableAppId`).
 */
export function assertNotReservedAppId(appId: string): void {
  if (RESERVED_APP_IDS.has(appId)) {
    throw new Error(
      `appId ${JSON.stringify(appId)} is reserved for a built-in app and cannot be installed by a third-party manifest`,
    );
  }
}

/**
 * Cloud-installable appIds must survive IAM role names, Postgres role names,
 * S3 prefixes, and URL paths without per-component encoding tricks. The
 * regex below is the conservative intersection: lowercase, starts with
 * alnum, no `/`, `@`, `+`, `=`, etc. Mirrored in the cloud handler's
 * `parseAppPath` regex (see cloud-data-server/src/api-handler.ts).
 */
const CLOUD_APP_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

export function assertCloudInstallableAppId(appId: string): void {
  if (!CLOUD_APP_ID_RE.test(appId)) {
    throw new Error(
      `appId ${JSON.stringify(appId)} is not cloud-installable: must match ${CLOUD_APP_ID_RE}`,
    );
  }
}

export async function createAppRole(input: CreateAppRoleInput): Promise<string> {
  const {
    stackPrefix, appId, accountId,
    permissionsBoundaryArn, foundationalPermissionsBoundaryArn,
    userDataOwnerPermissionsBoundaryArn,
    fileAccess, fileAccessAll,
    brokerPower, managerCreds,
  } = input;
  const iam = makeIamClient(managerCreds);
  const roleName = `${stackPrefix}-app-${appId}-role`;

  const boundaryArn =
    appId === FOUNDATIONAL_APP_ID
      ? foundationalPermissionsBoundaryArn
      : appId === USER_DATA_OWNER_APP_ID
        ? userDataOwnerPermissionsBoundaryArn
        : permissionsBoundaryArn;

  const categories = fileAccessAll
    ? [...APP_GRANTABLE_CATEGORIES]
    : categoriesOf(fileAccess);
  const hasWriteAccess = fileAccessAll || fileAccess.some((e) => e.access === "readwrite");

  const assumeRolePolicy = buildAppRoleTrustPolicy(
    stackPrefix,
    accountId,
    appId !== FOUNDATIONAL_APP_ID,
  );
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
    stackPrefix, appId, categories, hasWriteAccess, fileAccessAll,
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
            {
              // Broker reads every per-app HMAC credential so it can verify
              // signatures on /apps/{appId}/* requests. Scoped to the
              // per-stack creds path; no other SSM parameters are reachable.
              Sid: "BrokerReadAppCreds",
              Effect: "Allow",
              Action: "ssm:GetParameter",
              Resource: `arn:aws:ssm:*:${accountId}:parameter/${stackPrefix}/app-creds/*`,
            },
            {
              // SecureString — decrypt via the SSM service key.
              Sid: "BrokerReadAppCredsKmsDecrypt",
              Effect: "Allow",
              Action: "kms:Decrypt",
              Resource: "*",
              Condition: {
                StringLike: { "kms:ViaService": "ssm.*.amazonaws.com" },
              },
            },
          ],
        }),
      }),
    );
  }

  return `arn:aws:iam::${accountId}:role/${roleName}`;
}

/**
 * Attach the per-app temp policy to the install-infra-role. install-infra is
 * a centralized role; the policy name is keyed by appId so concurrent installs
 * of different apps cannot clobber each other. Detached after the
 * compute-stack step completes.
 */
export async function attachTempInstallInfraPolicy(
  stackPrefix: string,
  appId: string,
  accountId: string,
  region: string,
  managerCreds: AwsCredentials,
): Promise<void> {
  const iam = makeIamClient(managerCreds);
  await iam.send(
    new PutRolePolicyCommand({
      RoleName: `${stackPrefix}-install-infra-role`,
      PolicyName: `temp-install-infra-${appId}`,
      PolicyDocument: buildTempInstallInfraPolicy(stackPrefix, appId, accountId, region),
    }),
  );
}

export async function detachTempInstallInfraPolicy(
  stackPrefix: string,
  appId: string,
  managerCreds: AwsCredentials,
): Promise<void> {
  const iam = makeIamClient(managerCreds);
  await iam.send(
    new DeleteRolePolicyCommand({
      RoleName: `${stackPrefix}-install-infra-role`,
      PolicyName: `temp-install-infra-${appId}`,
    }),
  );
}

export async function attachTempUninstallInfraPolicy(
  stackPrefix: string,
  appId: string,
  accountId: string,
  region: string,
  managerCreds: AwsCredentials,
): Promise<void> {
  const iam = makeIamClient(managerCreds);
  await iam.send(
    new PutRolePolicyCommand({
      RoleName: `${stackPrefix}-install-infra-role`,
      PolicyName: `temp-uninstall-infra-${appId}`,
      PolicyDocument: buildTempUninstallInfraPolicy(stackPrefix, appId, accountId, region),
    }),
  );
}

export async function detachTempUninstallInfraPolicy(
  stackPrefix: string,
  appId: string,
  managerCreds: AwsCredentials,
): Promise<void> {
  const iam = makeIamClient(managerCreds);
  await iam.send(
    new DeleteRolePolicyCommand({
      RoleName: `${stackPrefix}-install-infra-role`,
      PolicyName: `temp-uninstall-infra-${appId}`,
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
/**
 * Build the standard per-app role trust policy. Up to three trusted
 * principals:
 *   1. lambda.amazonaws.com — so the per-app Lambda(s) can assume the role
 *      as their exec identity.
 *   2. Manager role — so install/uninstall orchestration can assume the role
 *      for data-plane setup (S3 .keep marker, sync attribution).
 *   3. Cloud-data-server role — so the CDS broker can single-hop assume per-app
 *      roles for runtime data brokering (replaces the older Lambda→Manager→app
 *      double-hop; see G9a).
 *
 * `includeCloudDataServerPrincipal` controls whether (3) is emitted. It must
 * be false when minting the cloud-data-server role itself (the role does not
 * yet exist, and AWS rejects Principal AWS ARNs that don't resolve). For
 * every other app it should be true.
 */
export function buildAppRoleTrustPolicy(
  stackPrefix: string,
  accountId: string,
  includeCloudDataServerPrincipal: boolean,
): string {
  const statements: object[] = [
    {
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
    {
      Effect: "Allow",
      Principal: {
        AWS: `arn:aws:iam::${accountId}:role/${stackPrefix}-manager-role`,
      },
      Action: "sts:AssumeRole",
    },
  ];
  if (includeCloudDataServerPrincipal) {
    statements.push({
      Effect: "Allow",
      Principal: {
        AWS: `arn:aws:iam::${accountId}:role/${stackPrefix}-app-cloud-data-server-role`,
      },
      Action: "sts:AssumeRole",
    });
  }
  return JSON.stringify({ Version: "2012-10-17", Statement: statements });
}

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
      PolicyDocument: buildAppRoleTrustPolicy(
        stackPrefix,
        accountId,
        appId !== FOUNDATIONAL_APP_ID,
      ),
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
