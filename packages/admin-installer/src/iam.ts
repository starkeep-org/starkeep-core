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
  USER_DATA_OWNER_APP_ID,
  buildAppExecPolicy,
  appExecRoleName,
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
 * Defined in temp-policies.ts (the runtime-policy builder needs it to decide
 * who may read the inventory prefix) and re-exported here, which is where the
 * rest of the installer has always looked for it.
 */
export { USER_DATA_OWNER_APP_ID, appExecRoleName } from "./temp-policies";

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
  try {
    await iam.send(
      new DeleteRolePolicyCommand({
        RoleName: `${stackPrefix}-install-infra-role`,
        PolicyName: `temp-install-infra-${appId}`,
      }),
    );
  } catch (err) {
    // Idempotent teardown: an already-absent policy is success, not failure.
    if ((err as { name?: string }).name !== "NoSuchEntityException") throw err;
  }
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

/**
 * Mint (or update) an app's Lambda **execution** role.
 *
 * Distinct from the data role in exactly one way that matters: it can write
 * logs, read its own HMAC credential, and invoke its own siblings, and it can
 * do nothing else. No S3, no DSQL, no `sts:AssumeRole` — so app code that
 * wants user data has to ask the broker for it, over HMAC, and be told no per
 * type.
 *
 * Two limits worth stating rather than leaving implied. Blast radius is
 * unchanged: the data role's grants are not narrowed, so a broker defect still
 * exposes everything rather than only the declared types — narrowing them
 * needs per-type views or a per-app schema projection, since DSQL has no RLS.
 * And the local surface is untouched and unfixable: a local app runs as the
 * user and can open the SQLite file directly. The manifest is binding in the
 * cloud and advisory locally.
 */
export async function createAppExecRole(input: {
  stackPrefix: string;
  appId: string;
  accountId: string;
  permissionsBoundaryArn: string;
  foundationalPermissionsBoundaryArn: string;
  userDataOwnerPermissionsBoundaryArn: string;
  managerCreds: AwsCredentials;
}): Promise<string> {
  const { stackPrefix, appId, accountId, managerCreds } = input;
  const iam = makeIamClient(managerCreds);
  const roleName = appExecRoleName(stackPrefix, appId);

  const boundaryArn =
    appId === FOUNDATIONAL_APP_ID
      ? input.foundationalPermissionsBoundaryArn
      : appId === USER_DATA_OWNER_APP_ID
        ? input.userDataOwnerPermissionsBoundaryArn
        : input.permissionsBoundaryArn;

  // Lambda and nothing else. Stated as the whole principal list rather than as
  // an absence, because the property wanted is "nothing else can assume this".
  const assumeRolePolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "lambda.amazonaws.com" },
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
        Tags: [
          { Key: "starkeep:appId", Value: appId },
          { Key: "starkeep:managed", Value: "true" },
        ],
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

  await iam.send(
    new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: "exec",
      PolicyDocument: buildAppExecPolicy(stackPrefix, appId),
    }),
  );

  return `arn:aws:iam::${accountId}:role/${roleName}`;
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
 * Delete an app's exec role and its inline policy. Mirrors
 * {@link deleteAppRoleWithPolicies}; an uninstall that removed the data role
 * and left this one behind would leave a role able to read the app's HMAC
 * credential after the app was gone.
 */
export async function deleteAppExecRoleWithPolicies(
  stackPrefix: string,
  appId: string,
  managerCreds: AwsCredentials,
): Promise<void> {
  const iam = makeIamClient(managerCreds);
  const roleName = appExecRoleName(stackPrefix, appId);
  try {
    const { PolicyNames = [] } = await iam.send(
      new ListRolePoliciesCommand({ RoleName: roleName }),
    );
    for (const policyName of PolicyNames) {
      await iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }));
    }
    await iam.send(new DeleteRoleCommand({ RoleName: roleName }));
  } catch (err) {
    // An app installed before the role split has no exec role to delete, and
    // an uninstall must not fail on its absence.
    if ((err as { name?: string }).name !== "NoSuchEntityException") throw err;
  }
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
 * Build the standard per-app **data** role trust policy. Trusted principals:
 *   1. Manager role — so install/uninstall orchestration can assume the role
 *      for data-plane setup (S3 .keep marker, sync attribution).
 *   2. Cloud-data-server role — so the CDS broker can single-hop assume per-app
 *      roles for runtime data brokering (replaces the older Lambda→Manager→app
 *      double-hop; see G9a).
 *   3. lambda.amazonaws.com — for the cloud-data-server's own role only.
 *
 * `lambda.amazonaws.com` used to be a third principal, so an app's own
 * handlers ran as this role. That made the manifest non-binding on the app
 * that wrote it: the role holds `s3:GetObject` on `shared/<category>/*` and
 * `dsql:DbConnect`, so app code could read every record row of every type and
 * fetch any blob in a granted category directly — bypassing the broker, the
 * HMAC scheme, and every grant check the broker performs. App handlers now run
 * as `${stackPrefix}-app-<appId>-exec-role` instead (see createAppExecRole),
 * and this role is reachable only by the principals below.
 *
 * The cloud-data-server keeps the Lambda principal, and that is not an
 * exception to the rule so much as the rule pointing the other way: the broker
 * *is* the thing the grants exist for. Its Lambda has to run as the identity
 * that holds them, and there is no app code inside it to confine — it is the
 * confinement.
 *
 * `includeCloudDataServerPrincipal` controls whether (2) is emitted. It must
 * be false when minting the cloud-data-server role itself (the role does not
 * yet exist, and AWS rejects Principal AWS ARNs that don't resolve). For
 * every other app it should be true — so the same flag, inverted, is what says
 * "this is the broker" for the Lambda principal above.
 */
export function buildAppRoleTrustPolicy(
  stackPrefix: string,
  accountId: string,
  includeCloudDataServerPrincipal: boolean,
): string {
  const isCloudDataServer = !includeCloudDataServerPrincipal;
  const statements: object[] = [
    ...(isCloudDataServer
      ? [
          {
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ]
      : []),
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
