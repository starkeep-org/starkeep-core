/**
 * Registry of named IAM-evaluation contexts.
 *
 * A "context" is everything iam-simulate needs to evaluate a captured AWS
 * call: the principal, the identity policies attached to it, and the
 * permissions boundary. Each named context describes one role-at-a-moment
 * — e.g. the cloud-data-server app role during a Pulumi install vs. the
 * same role at runtime (different inline policies attached).
 *
 * Contexts pull their policies from the same builders the admin-installer
 * uses at runtime (relative imports, not duplicated copies), so a policy
 * change automatically updates the simulator's view of "what's attached
 * right now".
 *
 * To add a context:
 *   1. Add a CONTEXTS entry below with its identity policies + boundary.
 *   2. Capture a trace by running under that context (or hand-list calls).
 *   3. Invoke the CLI with --context=<your-name> <trace-files>.
 */

import {
  buildTempInstallCloudDataServerPolicy,
  buildTempInstallDdlPolicy,
  buildTempInstallInfraPolicy,
  buildRuntimePolicy,
} from "../../admin-installer/src/temp-policies";
import { adminAppPolicyStatements } from "../../aws-bootstrap/src/bootstrap/admin-app-policy";
import { foundationalPermissionsBoundaryStatements } from "../../aws-bootstrap/src/bootstrap/foundational-permissions-boundary";
import { installDdlBoundaryStatements } from "../../aws-bootstrap/src/bootstrap/install-ddl-boundary";
import { installInfraBoundaryStatements } from "../../aws-bootstrap/src/bootstrap/install-infra-boundary";
import { managerPolicyStatements } from "../../aws-bootstrap/src/bootstrap/manager-policy";
import { appPermissionsBoundaryStatements } from "../../aws-bootstrap/src/bootstrap/permissions-boundary";

export interface ContextInput {
  stackPrefix: string;
  accountId: string;
  region: string;
  /** Per-app contexts (install-ddl, install-infra, runtime-app) need an appId. */
  appId?: string;
}

export interface PolicyDoc {
  name: string;
  policy: unknown;
}

export interface IamContext {
  /** What iam-simulate sees as the calling principal (an assumed-role session ARN). */
  principalArn: string;
  /**
   * IAM role name part of `principalArn` (the segment after `assumed-role/`
   * and before the next `/`). Used to filter captured calls by role at trace
   * replay time — captured-call ARNs have real session names that won't
   * match `principalArn` literally.
   */
  principalRoleName: string;
  identityPolicies: PolicyDoc[];
  permissionBoundaryPolicies: PolicyDoc[];
  /** Context variables (aws:PrincipalTag/*, etc.) the principal carries at evaluation time. */
  contextVariables: Record<string, string | string[]>;
}

/**
 * Models a single AWS call that a context is *expected* to make at install
 * (or runtime) time, with concrete action + resource ARN. Expected calls are
 * the source-of-truth for "deployments will work" — captured traces only
 * confirm the model against what really happened.
 */
export interface ExpectedCall {
  action: string;
  /** Concrete resource ARN, or `*` for list-level actions. */
  resource: string;
  /** Optional per-call context variables (iam:PassedToService etc.). */
  contextVariables?: Record<string, string | string[]>;
  /** Human-readable note shown next to the call in output. */
  why: string;
}

interface ContextBuilder {
  /** One-line description shown by `--list-contexts`. */
  description: string;
  build(input: ContextInput): IamContext;
  /**
   * The set of AWS calls this context is expected to make. Modeled
   * declaratively so the simulator can verify policy ∩ boundary covers them
   * *before* the deploy ever runs — captured traces are confirmation, not
   * input. May be empty for contexts still being modeled.
   */
  expectedCalls(input: ContextInput): ExpectedCall[];
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function assumedRoleArn(accountId: string, roleName: string, session = "test"): string {
  return `arn:aws:sts::${accountId}:assumed-role/${roleName}/${session}`;
}

function brokerPowerPolicy(stackPrefix: string, accountId: string): PolicyDoc {
  return {
    name: "broker-power",
    policy: {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "BrokerAssumeAppRoles",
          Effect: "Allow",
          Action: "sts:AssumeRole",
          // Matches iam.ts:147 exactly — `-app-*` (no trailing `-role`) so
          // any future role-name suffix variants are covered too.
          Resource: `arn:aws:iam::${accountId}:role/${stackPrefix}-app-*`,
        },
      ],
    },
  };
}

function foundationalBoundary(stackPrefix: string): PolicyDoc {
  return {
    name: "foundational-boundary",
    policy: {
      Version: "2012-10-17",
      Statement: foundationalPermissionsBoundaryStatements(stackPrefix),
    },
  };
}

function installInfraBoundary(stackPrefix: string): PolicyDoc {
  return {
    name: "install-infra-boundary",
    policy: {
      Version: "2012-10-17",
      Statement: installInfraBoundaryStatements(stackPrefix),
    },
  };
}

/**
 * Resolve CloudFormation `{Sub: 's'}` (and other CfnValue shapes) into the
 * plain strings iam-simulate expects. Policies authored for CloudFormation
 * (manager-policy.ts, etc.) wrap every Resource/Condition value in `Sub`,
 * but at TS build time those strings have already been interpolated — there
 * are no `${AWS::AccountId}`-style markers left. So unwrapping is sufficient.
 *
 * Throws on `Ref`/`GetAtt` because those would need real CFN resolution
 * and no current contexts use them.
 */
function resolveCfnValues<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(resolveCfnValues) as unknown as T;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.Sub === "string" && Object.keys(obj).length === 1) {
      return obj.Sub as unknown as T;
    }
    if ("Ref" in obj || "GetAtt" in obj) {
      throw new Error(
        `iam-simulate cannot resolve CFN intrinsic ${JSON.stringify(obj)}; ` +
          "extend resolveCfnValues if a context needs this.",
      );
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = resolveCfnValues(v);
    return out as unknown as T;
  }
  return value;
}

function adminAppPolicy(stackPrefix: string, accountId: string, region: string): PolicyDoc {
  // adminAppPolicyStatements is the one bootstrap policy still authored for
  // CloudFormation to interpolate at deploy time: it uses `${AWS::Region}` in
  // the kms:ViaService condition and `{ GetAtt: "UserPool.Arn" }` for the
  // cognito statements. Neither survives `resolveCfnValues` on its own, so we
  // pre-substitute both: wildcard for the user pool ARN (cognito statements
  // aren't on the rotation hot path), and the concrete region for the kms
  // condition (load-bearing — the simulator must see the resolved value to
  // match the captured/expected call's kms:ViaService context).
  const userPoolArn = `arn:aws:cognito-idp:*:${accountId}:userpool/*`;
  const substituted = JSON.parse(
    JSON.stringify(adminAppPolicyStatements(stackPrefix), (_k, v) => {
      if (
        v &&
        typeof v === "object" &&
        "GetAtt" in (v as object) &&
        (v as { GetAtt: unknown }).GetAtt === "UserPool.Arn"
      ) {
        return userPoolArn;
      }
      return v;
    }),
  );
  const fillPseudoParams = (v: unknown): unknown => {
    if (typeof v === "string") {
      return v.replaceAll("${AWS::Region}", region).replaceAll("${AWS::AccountId}", accountId);
    }
    if (Array.isArray(v)) return v.map(fillPseudoParams);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
        out[k] = fillPseudoParams(vv);
      }
      return out;
    }
    return v;
  };
  return {
    name: "admin-app-inline",
    policy: {
      Version: "2012-10-17",
      Statement: fillPseudoParams(resolveCfnValues(substituted)) as unknown[],
    },
  };
}

function managerPolicy(stackPrefix: string): PolicyDoc {
  return {
    name: "manager-inline",
    policy: {
      Version: "2012-10-17",
      Statement: resolveCfnValues(managerPolicyStatements(stackPrefix)),
    },
  };
}

function appPermissionsBoundary(stackPrefix: string): PolicyDoc {
  return {
    name: "app-permissions-boundary",
    policy: {
      Version: "2012-10-17",
      Statement: appPermissionsBoundaryStatements(stackPrefix),
    },
  };
}

function installDdlBoundary(stackPrefix: string): PolicyDoc {
  return {
    name: "install-ddl-boundary",
    policy: {
      Version: "2012-10-17",
      Statement: installDdlBoundaryStatements(stackPrefix),
    },
  };
}

function requireAppId(name: string, appId: string | undefined): string {
  if (!appId) {
    throw new Error(`context '${name}' requires APP_ID (or appId in ContextInput).`);
  }
  return appId;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const CONTEXTS: Record<string, ContextBuilder> = {
  "admin-app": {
    description:
      "Admin-app role (federated Cognito user) at cli-install-cloud-data-server " +
      "start — runs the Pulumi-passphrase rotation (ssm get/put + kms via ssm) " +
      "and assumes Manager before any provisioning. Bootstrap-created role with " +
      "no permissions boundary; its inline policy is the entire cap.",
    build({ stackPrefix, accountId, region }) {
      const roleName = `${stackPrefix}-app-admin-role`;
      return {
        principalArn: assumedRoleArn(accountId, roleName, "install"),
        principalRoleName: roleName,
        identityPolicies: [adminAppPolicy(stackPrefix, accountId, region)],
        // Admin-app is bootstrap-created (same as Manager) with no boundary.
        permissionBoundaryPolicies: [],
        contextVariables: {
          "aws:PrincipalTag/starkeep:appId": "admin",
        },
      };
    },
    expectedCalls({ stackPrefix, accountId, region }): ExpectedCall[] {
      const passphraseArn = `arn:aws:ssm:${region}:${accountId}:parameter/${stackPrefix}/pulumi/passphrase`;
      const managerRoleArn = `arn:aws:iam::${accountId}:role/${stackPrefix}-manager-role`;
      const ssmViaService = `ssm.${region}.amazonaws.com`;
      return [
        {
          action: "sts:GetCallerIdentity",
          resource: "*",
          why: "cli-install-cloud-data-server resolves the AWS account ID up front when not in config.",
        },
        {
          action: "ssm:GetParameter",
          resource: passphraseArn,
          why: "ensurePulumiPassphrase reads the parameter (WithDecryption) to decide create-vs-skip.",
        },
        {
          action: "ssm:PutParameter",
          resource: passphraseArn,
          why: "If the parameter does not yet exist, ensurePulumiPassphrase creates it as a fresh SecureString.",
        },
        {
          action: "ssm:AddTagsToResource",
          resource: passphraseArn,
          why: "PutParameter with Tags triggers a separate ssm:AddTagsToResource authorization check (the starkeep:managed tag on initial creation).",
        },
        {
          action: "kms:Decrypt",
          resource: "*",
          contextVariables: { "kms:ViaService": ssmViaService },
          why:
            "GetParameter WithDecryption on the SecureString (post first creation) " +
            "flows through KMS via SSM. Admin-app grants kms:Encrypt+Decrypt scoped " +
            "by kms:ViaService — must stay covered.",
        },
        {
          action: "kms:Encrypt",
          resource: "*",
          contextVariables: { "kms:ViaService": ssmViaService },
          why: "PutParameter Type=SecureString during initial creation encrypts via KMS via SSM.",
        },
        {
          action: "sts:AssumeRole",
          resource: managerRoleArn,
          why:
            "installCloudDataServer's roleChain([managerRoleArn]) hops admin-app → Manager " +
            "before any provisioning runs. Without this the install never reaches Pulumi.",
        },
      ];
    },
  },

  "install-cloud-data-server": {
    description:
      "cloud-data-server app role during pulumi up — broker-power + " +
      "temp-install-cloud-data-server, foundational boundary.",
    build({ stackPrefix, accountId, region }) {
      const roleName = `${stackPrefix}-app-cloud-data-server-role`;
      const tempInstall: PolicyDoc = {
        name: "temp-install-cloud-data-server",
        policy: JSON.parse(
          buildTempInstallCloudDataServerPolicy(stackPrefix, accountId, region),
        ),
      };
      return {
        principalArn: assumedRoleArn(accountId, roleName, "install"),
        principalRoleName: roleName,
        identityPolicies: [brokerPowerPolicy(stackPrefix, accountId), tempInstall],
        permissionBoundaryPolicies: [foundationalBoundary(stackPrefix)],
        contextVariables: {
          "aws:PrincipalTag/starkeep:appId": "cloud-data-server",
        },
      };
    },
    expectedCalls({ stackPrefix, accountId, region }) {
      // Pulumi's full call set isn't enumerated here yet (captured traces
      // remain the primary source). What IS modeled: the passphrase reads,
      // because after admin-app creates /pulumi/passphrase as a SecureString,
      // every subsequent CDS pulumi up needs both ssm:GetParameter on that
      // parameter AND kms:Decrypt via ssm. Catching a missing kms statement
      // here is the whole point of running the simulator pre-deploy.
      const passphraseArn = `arn:aws:ssm:${region}:${accountId}:parameter/${stackPrefix}/pulumi/passphrase`;
      return [
        {
          action: "ssm:GetParameter",
          resource: passphraseArn,
          why: "Pulumi loads the passphrase for state encryption on every up/destroy.",
        },
        {
          action: "kms:Decrypt",
          resource: "*",
          contextVariables: { "kms:ViaService": `ssm.${region}.amazonaws.com` },
          why: "Passphrase is a SecureString post-rotation; decryption flows through KMS via SSM.",
        },
        {
          action: "lambda:PutFunctionConcurrency",
          resource: `arn:aws:lambda:${region}:${accountId}:function:${stackPrefix}-app-cloud-data-server-api`,
          why:
            "The broker Lambda declares reservedConcurrentExecutions; AWS sets it via a " +
            "separate PutFunctionConcurrency call (create and update alike). Both the " +
            "temp-install-cloud-data-server policy AND the foundational boundary must grant " +
            "it — a missing grant silently fails the Lambda update. Only the CDS stack sets " +
            "reserved concurrency, so the per-app install-infra context intentionally omits it.",
        },
      ];
    },
  },

  "runtime-cloud-data-server": {
    description:
      "cloud-data-server Lambda runtime — broker-power + runtime (no " +
      "temp-install), capped by the foundational boundary. Models the " +
      "AssumeRole / log-write calls the Lambda makes on every sync request. " +
      "Set APP_ID to scope the AssumeRole target to a concrete per-app role.",
    build({ stackPrefix, accountId }) {
      const roleName = `${stackPrefix}-app-cloud-data-server-role`;
      const runtime: PolicyDoc = {
        name: "runtime",
        // CDS is installed with fileAccess=[] (see builtin-installs.ts) —
        // runtime data access happens under the assumed app creds, not the
        // broker's exec creds, so AppS3SharedData isn't needed on the CDS role
        // itself.
        policy: JSON.parse(
          buildRuntimePolicy(stackPrefix, "cloud-data-server", [], false, false),
        ),
      };
      return {
        principalArn: assumedRoleArn(accountId, roleName, "runtime"),
        principalRoleName: roleName,
        identityPolicies: [brokerPowerPolicy(stackPrefix, accountId), runtime],
        permissionBoundaryPolicies: [foundationalBoundary(stackPrefix)],
        contextVariables: {
          "aws:PrincipalTag/starkeep:appId": "cloud-data-server",
        },
      };
    },
    expectedCalls({ stackPrefix, accountId, region, appId }) {
      // AssumeRole is the load-bearing runtime call — without it every sync
      // request 403s. Scope to a concrete per-app role ARN if APP_ID is set;
      // otherwise model the wildcard pattern the broker-power policy grants.
      const targetAppId = appId ?? "photos";
      const targetAppRoleArn = `arn:aws:iam::${accountId}:role/${stackPrefix}-app-${targetAppId}-role`;
      const cdsLambdaLogGroup = `arn:aws:logs:${region}:${accountId}:log-group:/aws/lambda/${stackPrefix}-app-cloud-data-server-api`;
      return [
        {
          action: "sts:AssumeRole",
          resource: targetAppRoleArn,
          why:
            "On every /apps/{appId}/sync/{pull,push} the CDS Lambda assumes the caller's " +
            "per-app role (single-hop broker pattern, api-handler.ts:64). Both broker-power " +
            "AND the foundational boundary must grant sts:AssumeRole on the per-app role pattern.",
        },
        {
          action: "logs:CreateLogStream",
          resource: cdsLambdaLogGroup,
          why: "Lambda runtime appends a log stream per invocation under the CDS log group.",
        },
        {
          action: "logs:PutLogEvents",
          resource: cdsLambdaLogGroup,
          why: "Lambda runtime writes log events for every invocation.",
        },
      ];
    },
  },
  "install-ddl": {
    description:
      "Per-app DSQL DDL phase — install-ddl-role with temp-install-ddl-<appId> " +
      "attached, capped by the install-ddl boundary. Set APP_ID to scope.",
    build({ stackPrefix, appId, accountId }) {
      const id = requireAppId("install-ddl", appId);
      const roleName = `${stackPrefix}-install-ddl-role`;
      const tempInstallDdl: PolicyDoc = {
        name: `temp-install-ddl-${id}`,
        // Temp DDL policy content is not appId-scoped; only the policy NAME
        // varies per app.
        policy: JSON.parse(buildTempInstallDdlPolicy(stackPrefix)),
      };
      return {
        principalArn: assumedRoleArn(accountId, roleName, "install"),
        principalRoleName: roleName,
        identityPolicies: [tempInstallDdl],
        permissionBoundaryPolicies: [installDdlBoundary(stackPrefix)],
        contextVariables: {},
      };
    },
    expectedCalls({ accountId, region }) {
      // The DDL phase makes exactly one IAM-evaluated call: signing a DSQL
      // admin connection. The actual SQL (CREATE TABLE etc.) flows over a
      // postgres connection, not an IAM-checked AWS API.
      return [
        {
          action: "dsql:DbConnectAdmin",
          resource: `arn:aws:dsql:${region}:${accountId}:cluster/*`,
          why: "runAppInstallDdl signs an admin connection to the DSQL cluster.",
        },
      ];
    },
  },
  "install-infra": {
    description:
      "Per-app AWS-resource provisioning phase — install-infra-role with " +
      "temp-install-infra-<appId> attached, capped by the install-infra boundary. " +
      "Covers bundle upload + Pulumi up (Lambda/logs/APIGw). Set APP_ID to scope.",
    build({ stackPrefix, accountId, region, appId }) {
      const id = requireAppId("install-infra", appId);
      const roleName = `${stackPrefix}-install-infra-role`;
      const tempInstallInfra: PolicyDoc = {
        name: `temp-install-infra-${id}`,
        policy: JSON.parse(
          buildTempInstallInfraPolicy(stackPrefix, id, accountId, region),
        ),
      };
      return {
        principalArn: assumedRoleArn(accountId, roleName, "install"),
        principalRoleName: roleName,
        identityPolicies: [tempInstallInfra],
        permissionBoundaryPolicies: [installInfraBoundary(stackPrefix)],
        contextVariables: {},
      };
    },
    expectedCalls({ stackPrefix, accountId, region, appId }): ExpectedCall[] {
      const id = requireAppId("install-infra", appId);
      const stateBucket = `${stackPrefix}-pulumi-state-${accountId}-${region}`;
      const stateKey = `arn:aws:s3:::${stateBucket}/.pulumi/stacks/${stackPrefix}-app-${id}.json`;
      const stateBucketArn = `arn:aws:s3:::${stateBucket}`;
      const artifactsBucket = `${stackPrefix}-artifacts-${accountId}-${region}`;
      const artifactsBucketArn = `arn:aws:s3:::${artifactsBucket}`;
      const artifactKey = `arn:aws:s3:::${artifactsBucket}/apps/${id}/latest/dist.zip`;
      const lambdaArn = `arn:aws:lambda:${region}:${accountId}:function:${stackPrefix}-app-${id}-api`;
      const logGroupArn = `arn:aws:logs:${region}:${accountId}:log-group:/aws/lambda/${stackPrefix}-app-${id}-api`;
      const appRoleArn = `arn:aws:iam::${accountId}:role/${stackPrefix}-app-${id}-role`;
      return [
        // Pulumi state I/O — read/write the per-app stack file plus the
        // shared .pulumi/ metadata.
        { action: "s3:GetObject", resource: stateKey, why: "Pulumi reads existing stack state." },
        { action: "s3:PutObject", resource: stateKey, why: "Pulumi writes updated stack state." },
        { action: "s3:DeleteObject", resource: stateKey, why: "Pulumi removes stack state on destroy." },
        { action: "s3:ListBucket", resource: stateBucketArn, why: "Pulumi enumerates state objects under .pulumi/." },
        { action: "s3:GetAccelerateConfiguration", resource: stateBucketArn, why: "probePulumiStateBucket() — IAM propagation probe before Pulumi up." },
        { action: "ssm:GetParameter", resource: `arn:aws:ssm:${region}:${accountId}:parameter/${stackPrefix}/pulumi/passphrase`, why: "Pulumi loads the passphrase for state encryption." },
        {
          action: "kms:Decrypt",
          resource: "*",
          contextVariables: { "kms:ViaService": `ssm.${region}.amazonaws.com` },
          why: "Passphrase is a SecureString post-rotation; GetParameter WithDecryption flows through KMS via SSM. Without the boundary's kms:Decrypt (via ssm) statement, Pulumi up 403s before reading state.",
        },

        // Artifacts upload + Pulumi-source read of the bundle.
        { action: "s3:PutObject", resource: artifactKey, why: "uploadAppBundle writes apps/<appId>/latest/dist.zip." },
        { action: "s3:GetObject", resource: artifactKey, why: "Pulumi's aws.lambda.Function reads the bundle as code source." },
        { action: "s3:ListBucket", resource: artifactsBucketArn, why: "Pulumi enumerates artifacts under apps/<appId>/." },

        // Lambda admin on the per-app function.
        { action: "lambda:CreateFunction", resource: lambdaArn, why: "Pulumi provisions the app's Lambda." },
        { action: "lambda:DeleteFunction", resource: lambdaArn, why: "destroy path." },
        { action: "lambda:GetFunction", resource: lambdaArn, why: "Pulumi refresh." },
        { action: "lambda:GetFunctionConfiguration", resource: lambdaArn, why: "Pulumi refresh." },
        { action: "lambda:UpdateFunctionCode", resource: lambdaArn, why: "redeploy with new bundle." },
        { action: "lambda:UpdateFunctionConfiguration", resource: lambdaArn, why: "env/memory/timeout updates." },
        { action: "lambda:TagResource", resource: lambdaArn, why: "Pulumi tagging." },
        { action: "lambda:UntagResource", resource: lambdaArn, why: "Pulumi tagging." },
        { action: "lambda:ListTags", resource: lambdaArn, why: "Pulumi refresh." },
        { action: "lambda:AddPermission", resource: lambdaArn, why: "aws.lambda.Permission for APIGw → invoke." },
        { action: "lambda:RemovePermission", resource: lambdaArn, why: "destroy path." },
        { action: "lambda:GetPolicy", resource: lambdaArn, why: "Pulumi refresh of resource-based policy." },
        { action: "lambda:ListVersionsByFunction", resource: lambdaArn, why: "Pulumi BucketV2-style refresh read." },
        { action: "lambda:GetFunctionCodeSigningConfig", resource: lambdaArn, why: "Pulumi refresh read." },
        { action: "lambda:GetFunctionConcurrency", resource: lambdaArn, why: "Pulumi refresh read." },
        { action: "lambda:GetFunctionUrlConfig", resource: lambdaArn, why: "Pulumi refresh read." },
        { action: "lambda:ListFunctionEventInvokeConfigs", resource: lambdaArn, why: "Pulumi refresh read." },
        { action: "lambda:GetRuntimeManagementConfig", resource: lambdaArn, why: "Pulumi refresh read." },

        // CloudWatch Logs: per-app log group lifecycle.
        { action: "logs:CreateLogGroup", resource: logGroupArn, why: "Pulumi provisions the app's log group." },
        { action: "logs:DeleteLogGroup", resource: logGroupArn, why: "destroy path." },
        { action: "logs:PutRetentionPolicy", resource: logGroupArn, why: "Pulumi sets retention." },
        { action: "logs:TagResource", resource: logGroupArn, why: "Pulumi tagging." },
        { action: "logs:UntagResource", resource: logGroupArn, why: "Pulumi tagging." },
        { action: "logs:ListTagsForResource", resource: logGroupArn, why: "Pulumi refresh." },
        { action: "logs:DescribeLogGroups", resource: "*", why: "Pulumi list-level read (must be on *)." },

        // API Gateway v2: integrations + routes hung off the shared API.
        { action: "apigatewayv2:GetApi", resource: "*", why: "Pulumi reads the shared API." },
        { action: "apigatewayv2:GetApis", resource: "*", why: "Pulumi refresh." },
        { action: "apigatewayv2:GetAuthorizer", resource: "*", why: "Pulumi reads JWT authorizer." },
        { action: "apigatewayv2:GetAuthorizers", resource: "*", why: "Pulumi refresh." },
        { action: "apigatewayv2:CreateIntegration", resource: "*", why: "Pulumi creates per-handler integration." },
        { action: "apigatewayv2:UpdateIntegration", resource: "*", why: "Pulumi updates integration." },
        { action: "apigatewayv2:DeleteIntegration", resource: "*", why: "destroy path." },
        { action: "apigatewayv2:GetIntegration", resource: "*", why: "Pulumi refresh." },
        { action: "apigatewayv2:GetIntegrations", resource: "*", why: "Pulumi refresh." },
        { action: "apigatewayv2:CreateRoute", resource: "*", why: "Pulumi creates per-handler route." },
        { action: "apigatewayv2:UpdateRoute", resource: "*", why: "Pulumi updates route." },
        { action: "apigatewayv2:DeleteRoute", resource: "*", why: "destroy path." },
        { action: "apigatewayv2:GetRoute", resource: "*", why: "Pulumi refresh." },
        { action: "apigatewayv2:GetRoutes", resource: "*", why: "Pulumi refresh." },
        { action: "apigatewayv2:TagResource", resource: "*", why: "Pulumi tagging." },
        { action: "apigatewayv2:UntagResource", resource: "*", why: "Pulumi tagging." },
        { action: "apigatewayv2:ListTagsForResource", resource: "*", why: "Pulumi refresh." },

        // Legacy apigateway: namespace verbs. The pulumi-aws provider
        // creates/updates v2 integrations and routes via REST-style POSTs to
        // `/apis/{api-id}/integrations` etc. — not `/v2/*` — so the resource
        // must match `/apis/*`. (Captured-call confirmation: photos install
        // hit `apigateway:POST` on `/apis/<id>/integrations`.)
        { action: "apigateway:GET", resource: "arn:aws:apigateway:*::/apis/*", why: "Pulumi reads integrations/routes via legacy namespace." },
        { action: "apigateway:POST", resource: "arn:aws:apigateway:*::/apis/*", why: "Pulumi creates integrations/routes via legacy namespace." },
        { action: "apigateway:PATCH", resource: "arn:aws:apigateway:*::/apis/*", why: "Pulumi updates integrations/routes via legacy namespace." },
        { action: "apigateway:PUT", resource: "arn:aws:apigateway:*::/apis/*", why: "Pulumi upserts integrations/routes via legacy namespace." },
        { action: "apigateway:DELETE", resource: "arn:aws:apigateway:*::/apis/*", why: "destroy path via legacy namespace." },
        { action: "apigateway:TagResource", resource: "arn:aws:apigateway:*::/tags/*", why: "Pulumi tags v2 resources via legacy namespace." },
        { action: "apigateway:UntagResource", resource: "arn:aws:apigateway:*::/tags/*", why: "Pulumi untags v2 resources via legacy namespace." },

        // STS pre-flight that Pulumi's aws provider issues for account/region
        // detection before any resource call. Always Allowed for any principal,
        // but modeled so the call ledger matches reality.
        { action: "sts:GetCallerIdentity", resource: "*", why: "pulumi-aws issues this on provider init to learn the calling account/region." },

        // iam:PassRole — required so Pulumi can attach the per-app role to
        // the new Lambda. Condition key must be set for the simulator.
        {
          action: "iam:PassRole",
          resource: appRoleArn,
          contextVariables: { "iam:PassedToService": "lambda.amazonaws.com" },
          why: "Pulumi's lambda.Function passes the app role as the Lambda execution role.",
        },
      ];
    },
  },
  "runtime-app": {
    description: "Per-app Lambda runtime (runtime policy, app boundary).",
    build() {
      throw new Error("context 'runtime-app' not implemented yet.");
    },
    expectedCalls() {
      return [];
    },
  },

  "install-manager": {
    description:
      "starkeep-manager-role during install/uninstall — mints per-app roles, " +
      "attaches/detaches temp install-ddl + install-infra policies, and chains " +
      "into the install-ddl/install-infra/app roles via sts:AssumeRole. No " +
      "permissions boundary (manager is a bootstrap-owned role).",
    build({ stackPrefix, accountId }) {
      const roleName = `${stackPrefix}-manager-role`;
      return {
        principalArn: assumedRoleArn(accountId, roleName, "install"),
        principalRoleName: roleName,
        identityPolicies: [managerPolicy(stackPrefix)],
        // Manager is created by the CloudFormation bootstrap stack and has no
        // permissions boundary attached — its inline policy IS the entire cap.
        permissionBoundaryPolicies: [],
        contextVariables: {},
      };
    },
    expectedCalls({ stackPrefix, accountId, appId }) {
      const id = requireAppId("install-manager", appId);
      const appRoleArn = `arn:aws:iam::${accountId}:role/${stackPrefix}-app-${id}-role`;
      const installDdlRoleArn = `arn:aws:iam::${accountId}:role/${stackPrefix}-install-ddl-role`;
      const installInfraRoleArn = `arn:aws:iam::${accountId}:role/${stackPrefix}-install-infra-role`;
      const appBoundaryArn = `arn:aws:iam::${accountId}:policy/${stackPrefix}-app-permissions-boundary`;
      return [
        // ---- Mint / heal the per-app role (createAppRole). --------------
        {
          action: "iam:CreateRole",
          resource: appRoleArn,
          contextVariables: { "iam:PermissionsBoundary": appBoundaryArn },
          why: "createAppRole provisions the per-app role with the app boundary attached.",
        },
        {
          action: "iam:UpdateAssumeRolePolicy",
          resource: appRoleArn,
          why: "createAppRole catches EntityAlreadyExists and re-applies the trust policy in place.",
        },
        {
          action: "iam:PutRolePolicy",
          resource: appRoleArn,
          why: "createAppRole attaches the inline 'runtime' policy (plus optional 'broker-power').",
        },
        {
          action: "iam:DeleteRolePolicy",
          resource: appRoleArn,
          why: "uninstall sweeps any leftover inline policies before iam:DeleteRole.",
        },
        {
          action: "iam:DeleteRole",
          resource: appRoleArn,
          why: "uninstallApp tears the per-app role down.",
        },
        {
          action: "iam:GetRole",
          resource: appRoleArn,
          why: "orchestrator existence-checks the per-app role on resume.",
        },
        {
          action: "iam:GetRolePolicy",
          resource: appRoleArn,
          why: "createAppRole re-reads the trust/inline policy to detect drift.",
        },
        {
          action: "iam:ListRolePolicies",
          resource: appRoleArn,
          why: "uninstall enumerates inline policies before deleting them.",
        },

        // ---- Mutate temp policies on install-ddl / install-infra. ------
        {
          action: "iam:PutRolePolicy",
          resource: installDdlRoleArn,
          why: "attachTempInstallDdlPolicy adds temp-install-ddl-<appId> to install-ddl-role.",
        },
        {
          action: "iam:DeleteRolePolicy",
          resource: installDdlRoleArn,
          why: "detachTempInstallDdlPolicy removes the temp policy after DDL completes.",
        },
        {
          action: "iam:GetRolePolicy",
          resource: installDdlRoleArn,
          why: "Manager reads the existing temp policy on resume to detect drift.",
        },
        {
          action: "iam:ListRolePolicies",
          resource: installDdlRoleArn,
          why: "Manager sweeps orphan temp-install-ddl-<appId> entries left by interrupted runs.",
        },
        {
          action: "iam:PutRolePolicy",
          resource: installInfraRoleArn,
          why: "attachTempInstallInfraPolicy adds temp-install-infra-<appId> to install-infra-role.",
        },
        {
          action: "iam:DeleteRolePolicy",
          resource: installInfraRoleArn,
          why: "detachTempInstallInfraPolicy removes the temp policy after Pulumi up completes.",
        },
        {
          action: "iam:GetRolePolicy",
          resource: installInfraRoleArn,
          why: "Manager reads the existing temp policy on resume to detect drift.",
        },
        {
          action: "iam:ListRolePolicies",
          resource: installInfraRoleArn,
          why: "Manager sweeps orphan temp-install-infra-<appId> entries left by interrupted runs.",
        },

        // ---- Role-chain into the three downstream roles. ---------------
        {
          action: "sts:AssumeRole",
          resource: appRoleArn,
          why: "Orchestrator assumes the app role to write the install-time .keep marker.",
        },
        {
          action: "sts:AssumeRole",
          resource: installDdlRoleArn,
          why: "Orchestrator assumes install-ddl-role for the per-app DSQL DDL phase.",
        },
        {
          action: "sts:AssumeRole",
          resource: installInfraRoleArn,
          why: "Orchestrator assumes install-infra-role for bundle upload + Pulumi up.",
        },

        // ---- Pre-flight identity check. --------------------------------
        {
          action: "sts:GetCallerIdentity",
          resource: "*",
          why: "cli-install-app resolves the AWS account ID up front when not in config.",
        },
      ];
    },
  },

  "install-app-role": {
    description:
      "Per-app role at install time (data-plane writes the orchestrator issues " +
      "directly under the app role — currently just the .keep marker). Identity " +
      "is the inline runtime policy; capped by the app permissions boundary. " +
      "Set APP_ID to scope.",
    build({ stackPrefix, appId, accountId }) {
      const id = requireAppId("install-app-role", appId);
      const roleName = `${stackPrefix}-app-${id}-role`;
      const runtime: PolicyDoc = {
        name: "runtime",
        // fileAccess/fileAccessAll shape the policy, but the .keep write uses
        // only AppS3OwnPrefix, which is unconditional — so an empty-categories
        // policy is sufficient for modeling the install-time call.
        policy: JSON.parse(
          buildRuntimePolicy(stackPrefix, id, [], false, false),
        ),
      };
      return {
        principalArn: assumedRoleArn(accountId, roleName, "install"),
        principalRoleName: roleName,
        identityPolicies: [runtime],
        permissionBoundaryPolicies: [appPermissionsBoundary(stackPrefix)],
        contextVariables: {
          "aws:PrincipalTag/starkeep:appId": id,
        },
      };
    },
    expectedCalls({ stackPrefix, appId }) {
      const id = requireAppId("install-app-role", appId);
      // filesBucket name follows the bootstrap convention — wildcard on the
      // account+region segment so the model matches the policy's wildcarded
      // resource ARN.
      const keepFileArn = `arn:aws:s3:::${stackPrefix}-files-*/apps/${id}/.keep`;
      return [
        {
          action: "s3:PutObject",
          resource: keepFileArn,
          why: "putAppKeepFile writes the zero-byte sentinel that marks the app's S3 presence.",
        },
      ];
    },
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function listContexts(): Array<{ name: string; description: string }> {
  return Object.entries(CONTEXTS).map(([name, c]) => ({ name, description: c.description }));
}

export function buildContext(name: string, input: ContextInput): IamContext {
  const ctx = CONTEXTS[name];
  if (!ctx) {
    const available = Object.keys(CONTEXTS).join(", ");
    throw new Error(`unknown context '${name}'. Available: ${available}`);
  }
  return ctx.build(input);
}

export function expectedCallsFor(name: string, input: ContextInput): ExpectedCall[] {
  const ctx = CONTEXTS[name];
  if (!ctx) {
    const available = Object.keys(CONTEXTS).join(", ");
    throw new Error(`unknown context '${name}'. Available: ${available}`);
  }
  return ctx.expectedCalls(input);
}
