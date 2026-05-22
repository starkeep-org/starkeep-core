/**
 * Temporary inline policies attached to an app role during install/uninstall.
 *
 * These are attached by Manager before the provisioning work begins and
 * detached immediately after. The permissions boundary still caps everything.
 */

/**
 * Temp policy for the install-ddl-role. Single statement granting
 * dsql:DbConnectAdmin, used for both install and uninstall DDL.
 * Attached to ${stackPrefix}-install-ddl-role (not the app role).
 */
export function buildTempInstallDdlPolicy(stackPrefix: string): string {
  void stackPrefix; // policy content is not stack-scoped; only the role name is
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "TempInstallDdlDbConnectAdmin",
        Effect: "Allow",
        Action: "dsql:DbConnectAdmin",
        Resource: "*",
      },
    ],
  });
}

/**
 * Temp policy for the install-infra-role, scoped to a single app being
 * installed. Attached to ${stackPrefix}-install-infra-role under policy name
 * temp-install-infra-${appId} and detached after the compute-stack step
 * completes. The install-infra-role itself has zero standing power at steady
 * state; this is the ephemeral grant that lets it provision the app's
 * Lambda(s), log group(s), and API Gateway routes.
 *
 * Every resource is scoped to the specific appId — concurrent installs of
 * different apps cannot affect each other because their temp policies sit
 * under different policy names on the same role with disjoint ARNs.
 */
export function buildTempInstallInfraPolicy(
  stackPrefix: string,
  appId: string,
  accountId: string,
  region: string,
): string {
  const pulumiStateBucket = `${stackPrefix}-pulumi-state-${accountId}-${region}`;
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "TempInstallInfraPulumiState",
        Effect: "Allow",
        Action: [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket",
          // Propagation probe target — see probePulumiStateBucket().
          "s3:GetAccelerateConfiguration",
        ],
        Resource: [
          `arn:aws:s3:::${pulumiStateBucket}`,
          `arn:aws:s3:::${pulumiStateBucket}/.pulumi/stacks/${stackPrefix}-app-${appId}.json`,
          `arn:aws:s3:::${pulumiStateBucket}/.pulumi/`,
          `arn:aws:s3:::${pulumiStateBucket}/.pulumi/*`,
        ],
      },
      {
        Sid: "TempInstallInfraSsmPassphrase",
        Effect: "Allow",
        Action: "ssm:GetParameter",
        Resource: `arn:aws:ssm:*:${accountId}:parameter/${stackPrefix}/pulumi/passphrase`,
      },
      {
        // uploadAppBundle writes apps/<appId>/latest/dist.zip;
        // Pulumi's lambda.Function reads the same key as code source.
        Sid: "TempInstallInfraArtifacts",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
        Resource: [
          // Suffixed bucket name (see bootstrap ArtifactsBucket); wildcard
          // absorbs the account+region suffix.
          `arn:aws:s3:::${stackPrefix}-artifacts-*`,
          `arn:aws:s3:::${stackPrefix}-artifacts-*/apps/${appId}/*`,
        ],
      },
      {
        Sid: "TempInstallInfraLambda",
        Effect: "Allow",
        Action: [
          "lambda:CreateFunction",
          "lambda:DeleteFunction",
          "lambda:GetFunction",
          "lambda:GetFunctionConfiguration",
          "lambda:UpdateFunctionCode",
          "lambda:UpdateFunctionConfiguration",
          "lambda:TagResource",
          "lambda:UntagResource",
          "lambda:ListTags",
          // AddPermission/GetPolicy: required for aws.lambda.Permission so
          // API Gateway can invoke per-app Lambdas (G3).
          "lambda:AddPermission",
          "lambda:RemovePermission",
          "lambda:GetPolicy",
          // Refresh-time reads that Pulumi's aws.lambda.Function fires on
          // every BucketV2-style refresh.
          "lambda:ListVersionsByFunction",
          "lambda:GetFunctionCodeSigningConfig",
          "lambda:GetFunctionConcurrency",
          "lambda:GetFunctionUrlConfig",
          "lambda:ListFunctionEventInvokeConfigs",
          "lambda:GetRuntimeManagementConfig",
        ],
        Resource: `arn:aws:lambda:*:${accountId}:function:${stackPrefix}-app-${appId}-*`,
      },
      {
        Sid: "TempInstallInfraLogs",
        Effect: "Allow",
        Action: [
          "logs:CreateLogGroup",
          "logs:DeleteLogGroup",
          "logs:PutRetentionPolicy",
          "logs:TagResource",
          "logs:UntagResource",
          "logs:ListTagsForResource",
        ],
        Resource: `arn:aws:logs:*:${accountId}:log-group:/aws/lambda/${stackPrefix}-app-${appId}-*`,
      },
      {
        // logs:DescribeLogGroups is a list-level action — AWS evaluates it
        // against the all-zeros resource, so it must be granted on "*".
        Sid: "TempInstallInfraLogsList",
        Effect: "Allow",
        Action: ["logs:DescribeLogGroups"],
        Resource: "*",
      },
      {
        Sid: "TempInstallInfraApiGatewayV2",
        Effect: "Allow",
        Action: [
          "apigatewayv2:GetApi",
          "apigatewayv2:GetApis",
          "apigatewayv2:GetAuthorizer",
          "apigatewayv2:GetAuthorizers",
          "apigatewayv2:CreateIntegration",
          "apigatewayv2:UpdateIntegration",
          "apigatewayv2:DeleteIntegration",
          "apigatewayv2:GetIntegration",
          "apigatewayv2:GetIntegrations",
          "apigatewayv2:CreateRoute",
          "apigatewayv2:UpdateRoute",
          "apigatewayv2:DeleteRoute",
          "apigatewayv2:GetRoute",
          "apigatewayv2:GetRoutes",
          "apigatewayv2:TagResource",
          "apigatewayv2:UntagResource",
          "apigatewayv2:ListTagsForResource",
        ],
        Resource: "*",
      },
      {
        // Legacy apigateway: namespace verbs for v2 integration/route paths
        // and tag operations. Despite the SDK being apigatewayv2, the
        // pulumi-aws (terraform) provider issues these as REST-style calls
        // against the `/apis/{api-id}/{integrations,routes,...}` paths, so
        // IAM evaluates them as `apigateway:VERB` on `/apis/*`. `/v2/*` is
        // kept for the (rarer) direct v2-namespace paths.
        Sid: "TempInstallInfraApiGatewayLegacy",
        Effect: "Allow",
        Action: [
          "apigateway:GET",
          "apigateway:POST",
          "apigateway:PATCH",
          "apigateway:PUT",
          "apigateway:DELETE",
          "apigateway:TagResource",
          "apigateway:UntagResource",
        ],
        Resource: [
          "arn:aws:apigateway:*::/apis",
          "arn:aws:apigateway:*::/apis/*",
          "arn:aws:apigateway:*::/v2/*",
          "arn:aws:apigateway:*::/tags/*",
        ],
      },
      {
        // Pulumi's lambda.Function CreateFunction passes the per-app role as
        // the Lambda exec role; install-infra is the principal making the
        // call, so iam:PassRole is evaluated against this temp policy.
        Sid: "TempInstallInfraPassRoleAppToLambda",
        Effect: "Allow",
        Action: "iam:PassRole",
        Resource: `arn:aws:iam::${accountId}:role/${stackPrefix}-app-${appId}-role`,
        Condition: {
          StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" },
        },
      },
    ],
  });
}

/** Symmetric uninstall variant — destroy-time + refresh-read verbs. */
export function buildTempUninstallInfraPolicy(
  stackPrefix: string,
  appId: string,
  accountId: string,
  region: string,
): string {
  const pulumiStateBucket = `${stackPrefix}-pulumi-state-${accountId}-${region}`;
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "TempUninstallInfraPulumiState",
        Effect: "Allow",
        Action: [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket",
          "s3:GetAccelerateConfiguration",
        ],
        Resource: [
          `arn:aws:s3:::${pulumiStateBucket}`,
          `arn:aws:s3:::${pulumiStateBucket}/.pulumi/stacks/${stackPrefix}-app-${appId}.json`,
          `arn:aws:s3:::${pulumiStateBucket}/.pulumi/`,
          `arn:aws:s3:::${pulumiStateBucket}/.pulumi/*`,
        ],
      },
      {
        Sid: "TempUninstallInfraSsmPassphrase",
        Effect: "Allow",
        Action: "ssm:GetParameter",
        Resource: `arn:aws:ssm:*:${accountId}:parameter/${stackPrefix}/pulumi/passphrase`,
      },
      {
        // Bundle cleanup happens in deleteAppObjects which runs under app
        // creds; install-infra needs read here so Pulumi's destroy-time
        // refresh on aws.lambda.Function can re-resolve the code source.
        Sid: "TempUninstallInfraArtifacts",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:ListBucket"],
        Resource: [
          `arn:aws:s3:::${stackPrefix}-artifacts-*`,
          `arn:aws:s3:::${stackPrefix}-artifacts-*/apps/${appId}/*`,
        ],
      },
      {
        Sid: "TempUninstallInfraLambda",
        Effect: "Allow",
        Action: [
          "lambda:DeleteFunction",
          "lambda:GetFunction",
          "lambda:GetFunctionConfiguration",
          // RemovePermission/GetPolicy: Pulumi destroy reads & deletes the
          // resource-based policy statement before deleting the function.
          "lambda:RemovePermission",
          "lambda:GetPolicy",
          // Refresh-time reads.
          "lambda:ListVersionsByFunction",
          "lambda:GetFunctionCodeSigningConfig",
          "lambda:GetFunctionConcurrency",
          "lambda:GetFunctionUrlConfig",
          "lambda:ListFunctionEventInvokeConfigs",
          "lambda:GetRuntimeManagementConfig",
        ],
        Resource: `arn:aws:lambda:*:${accountId}:function:${stackPrefix}-app-${appId}-*`,
      },
      {
        Sid: "TempUninstallInfraLogs",
        Effect: "Allow",
        Action: [
          "logs:DeleteLogGroup",
          "logs:ListTagsForResource",
        ],
        Resource: `arn:aws:logs:*:${accountId}:log-group:/aws/lambda/${stackPrefix}-app-${appId}-*`,
      },
      {
        Sid: "TempUninstallInfraLogsList",
        Effect: "Allow",
        Action: ["logs:DescribeLogGroups"],
        Resource: "*",
      },
      {
        Sid: "TempUninstallInfraApiGatewayV2",
        Effect: "Allow",
        Action: [
          "apigatewayv2:GetApi",
          "apigatewayv2:GetApis",
          "apigatewayv2:GetAuthorizer",
          "apigatewayv2:GetAuthorizers",
          "apigatewayv2:GetIntegration",
          "apigatewayv2:GetIntegrations",
          "apigatewayv2:DeleteIntegration",
          "apigatewayv2:GetRoute",
          "apigatewayv2:GetRoutes",
          "apigatewayv2:DeleteRoute",
          "apigatewayv2:ListTagsForResource",
        ],
        Resource: "*",
      },
      {
        // Legacy apigateway: DELETE/Untag is needed by Pulumi destroy on
        // integrations, routes, and tag-on-* resources. The provider issues
        // these against `/apis/{api-id}/...` paths (mirror of the install
        // policy above), not `/v2/*`.
        Sid: "TempUninstallInfraApiGatewayLegacy",
        Effect: "Allow",
        Action: [
          "apigateway:GET",
          "apigateway:DELETE",
          "apigateway:UntagResource",
        ],
        Resource: [
          "arn:aws:apigateway:*::/apis",
          "arn:aws:apigateway:*::/apis/*",
          "arn:aws:apigateway:*::/v2/*",
          "arn:aws:apigateway:*::/tags/*",
        ],
      },
    ],
  });
}

/**
 * Temp policy for the cloud-data-server built-in app. Wider than the per-app
 * variant because cloud-data-server's Pulumi stack provisions the foundational
 * cloud resources for the deployment: the DSQL cluster, the files bucket, the
 * protocol-core Lambda function, and the API Gateway with a Cognito JWT
 * authorizer. The permissions boundary still caps the total.
 */
export function buildTempInstallCloudDataServerPolicy(
  stackPrefix: string,
  accountId: string,
  region: string,
): string {
  const appId = "cloud-data-server";
  const pulumiStateBucket = `${stackPrefix}-pulumi-state-${accountId}-${region}`;
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "TempInstallPulumiState",
        Effect: "Allow",
        Action: [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket",
          // Used as a propagation probe: probePulumiStateBucket waits for
          // this action to succeed before handing control to Pulumi, ensuring
          // that PutRolePolicy's IAM cache propagation is complete for
          // s3:GetAccelerateConfiguration (which Pulumi reads on every
          // BucketV2 create/refresh). Probing on the known-existing state
          // bucket is the only pre-Pulumi S3 target we can use.
          "s3:GetAccelerateConfiguration",
        ],
        Resource: [
          `arn:aws:s3:::${pulumiStateBucket}`,
          `arn:aws:s3:::${pulumiStateBucket}/.pulumi/`,
          `arn:aws:s3:::${pulumiStateBucket}/.pulumi/*`,
        ],
      },
      {
        Sid: "TempInstallSsmPassphrase",
        Effect: "Allow",
        Action: "ssm:GetParameter",
        Resource: `arn:aws:ssm:*:${accountId}:parameter/${stackPrefix}/pulumi/passphrase`,
      },
      {
        Sid: "TempInstallDsqlAdmin",
        Effect: "Allow",
        Action: ["dsql:DbConnectAdmin", "dsql:DbConnect"],
        Resource: "*",
      },
      {
        Sid: "TempInstallDsqlCluster",
        Effect: "Allow",
        Action: [
          "dsql:CreateCluster",
          "dsql:GetCluster",
          "dsql:UpdateCluster",
          "dsql:DeleteCluster",
          "dsql:ListClusters",
          "dsql:TagResource",
          "dsql:UntagResource",
          "dsql:ListTagsForResource",
          // Pulumi/terraform-provider-aws reads this after CreateCluster.
          "dsql:GetVpcEndpointServiceName",
        ],
        Resource: "*",
      },
      {
        Sid: "TempInstallS3Bucket",
        Effect: "Allow",
        Action: [
          "s3:CreateBucket",
          "s3:DeleteBucket",
          "s3:GetBucketLocation",
          "s3:GetBucketPolicy",
          "s3:PutBucketPolicy",
          "s3:DeleteBucketPolicy",
          "s3:GetBucketTagging",
          "s3:PutBucketTagging",
          "s3:GetBucketVersioning",
          "s3:PutBucketVersioning",
          "s3:GetBucketAcl",
          "s3:GetBucketCORS",
          "s3:PutBucketCORS",
          "s3:GetBucketPublicAccessBlock",
          "s3:PutBucketPublicAccessBlock",
          "s3:GetBucketOwnershipControls",
          "s3:PutBucketOwnershipControls",
          "s3:GetEncryptionConfiguration",
          "s3:PutEncryptionConfiguration",
          "s3:GetBucketWebsite",
          "s3:GetAccelerateConfiguration",
          "s3:GetBucketLogging",
          "s3:GetBucketRequestPayment",
          "s3:GetBucketObjectLockConfiguration",
          "s3:GetReplicationConfiguration",
          "s3:GetLifecycleConfiguration",
          "s3:GetBucketNotification",
          "s3:ListBucket",
        ],
        Resource: [
          `arn:aws:s3:::${stackPrefix}-files-*`,
        ],
      },
      {
        Sid: "TempInstallS3FilesObjects",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        Resource: [`arn:aws:s3:::${stackPrefix}-files-*/*`],
      },
      {
        Sid: "TempInstallLambda",
        Effect: "Allow",
        Action: [
          "lambda:CreateFunction",
          "lambda:DeleteFunction",
          "lambda:GetFunction",
          "lambda:GetFunctionConfiguration",
          "lambda:UpdateFunctionCode",
          "lambda:UpdateFunctionConfiguration",
          "lambda:TagResource",
          "lambda:UntagResource",
          "lambda:ListTags",
          "lambda:AddPermission",
          "lambda:RemovePermission",
          "lambda:GetPolicy",
          "lambda:PublishVersion",
          "lambda:ListVersionsByFunction",
          "lambda:GetFunctionCodeSigningConfig",
          "lambda:GetFunctionConcurrency",
          "lambda:GetFunctionUrlConfig",
          "lambda:ListFunctionEventInvokeConfigs",
          // G9k — Pulumi reads runtime-management config on every refresh.
          "lambda:GetRuntimeManagementConfig",
        ],
        Resource: `arn:aws:lambda:*:${accountId}:function:${stackPrefix}-app-${appId}-*`,
      },
      {
        Sid: "TempInstallLogs",
        Effect: "Allow",
        Action: [
          "logs:CreateLogGroup",
          "logs:DeleteLogGroup",
          "logs:PutRetentionPolicy",
          "logs:TagResource",
          "logs:UntagResource",
          "logs:ListTagsForResource",
        ],
        Resource: `arn:aws:logs:*:${accountId}:log-group:/aws/lambda/${stackPrefix}-app-${appId}-*`,
      },
      {
        // List-level action — must be granted on Resource:"*".
        Sid: "TempInstallLogsList",
        Effect: "Allow",
        Action: ["logs:DescribeLogGroups"],
        Resource: "*",
      },
      {
        Sid: "TempInstallApiGateway",
        Effect: "Allow",
        Action: [
          "apigatewayv2:CreateApi",
          "apigatewayv2:UpdateApi",
          "apigatewayv2:DeleteApi",
          "apigatewayv2:GetApi",
          "apigatewayv2:GetApis",
          "apigatewayv2:CreateAuthorizer",
          "apigatewayv2:UpdateAuthorizer",
          "apigatewayv2:DeleteAuthorizer",
          "apigatewayv2:GetAuthorizer",
          "apigatewayv2:GetAuthorizers",
          "apigatewayv2:CreateStage",
          "apigatewayv2:UpdateStage",
          "apigatewayv2:DeleteStage",
          "apigatewayv2:GetStage",
          "apigatewayv2:GetStages",
          "apigatewayv2:CreateIntegration",
          "apigatewayv2:UpdateIntegration",
          "apigatewayv2:DeleteIntegration",
          "apigatewayv2:GetIntegration",
          "apigatewayv2:GetIntegrations",
          "apigatewayv2:CreateRoute",
          "apigatewayv2:UpdateRoute",
          "apigatewayv2:DeleteRoute",
          "apigatewayv2:GetRoute",
          "apigatewayv2:GetRoutes",
          "apigatewayv2:CreateApiMapping",
          "apigatewayv2:UpdateApiMapping",
          "apigatewayv2:DeleteApiMapping",
          "apigatewayv2:TagResource",
          "apigatewayv2:UntagResource",
          "apigatewayv2:ListTagsForResource",
        ],
        Resource: "*",
      },
      {
        // v2 HTTP API create/update/delete paths authorize against the legacy
        // `apigateway` IAM namespace with REST-method action names. The IAM
        // resource uses the un-prefixed path (e.g. /apis, /apis/*) rather than
        // /v2/apis — both forms appear in practice depending on the SDK version.
        // TagResource/UntagResource also fire under the legacy namespace when
        // tagging stages, integrations, and routes.
        Sid: "TempInstallApiGatewayRestActions",
        Effect: "Allow",
        Action: [
          "apigateway:GET",
          "apigateway:POST",
          "apigateway:PATCH",
          "apigateway:PUT",
          "apigateway:DELETE",
          "apigateway:TagResource",
          "apigateway:UntagResource",
        ],
        Resource: [
          "arn:aws:apigateway:*::/apis",
          "arn:aws:apigateway:*::/apis/*",
          "arn:aws:apigateway:*::/v2/*",
          "arn:aws:apigateway:*::/tags/*",
        ],
      },
      {
        Sid: "TempInstallPassRoleToLambda",
        Effect: "Allow",
        Action: "iam:PassRole",
        Resource: `arn:aws:iam::${accountId}:role/${stackPrefix}-app-${appId}-role`,
        Condition: {
          StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" },
        },
      },
      {
        Sid: "TempInstallBillingBucket",
        Effect: "Allow",
        Action: [
          "s3:CreateBucket",
          "s3:DeleteBucket",
          "s3:GetBucketAcl",
          "s3:GetBucketLocation",
          "s3:GetBucketPolicy",
          "s3:PutBucketPolicy",
          "s3:DeleteBucketPolicy",
          "s3:GetBucketTagging",
          "s3:PutBucketTagging",
          "s3:GetBucketVersioning",
          "s3:PutBucketVersioning",
          "s3:GetBucketPublicAccessBlock",
          "s3:PutBucketPublicAccessBlock",
          "s3:GetBucketOwnershipControls",
          "s3:PutBucketOwnershipControls",
          "s3:GetEncryptionConfiguration",
          "s3:PutEncryptionConfiguration",
          "s3:GetBucketCORS",
          "s3:GetBucketWebsite",
          "s3:GetAccelerateConfiguration",
          "s3:GetBucketLogging",
          "s3:GetBucketRequestPayment",
          "s3:GetBucketObjectLockConfiguration",
          "s3:GetReplicationConfiguration",
          "s3:GetLifecycleConfiguration",
          "s3:GetBucketNotification",
          "s3:ListBucket",
        ],
        Resource: `arn:aws:s3:::${stackPrefix}-billing-*`,
      },
      {
        Sid: "TempInstallCur",
        Effect: "Allow",
        Action: [
          "cur:PutReportDefinition",
          "cur:DescribeReportDefinitions",
          "cur:DeleteReportDefinition",
          "cur:ListTagsForResource",
          "cur:TagResource",
          "cur:UntagResource",
        ],
        Resource: "*",
      },
      {
        // First dsql:CreateCluster in an account may need the DSQL
        // service-linked role auto-created (G9i). This lives on the CDS
        // temp policy specifically because cloud-data-server is the only
        // identity that ever creates the DSQL cluster; per-app installs
        // never run dsql:CreateCluster and intentionally do not carry this
        // grant. Scoped to the DSQL service principal so no other SLRs can
        // be created from this grant.
        Sid: "TempInstallCreateDsqlServiceLinkedRole",
        Effect: "Allow",
        Action: "iam:CreateServiceLinkedRole",
        Resource: "*",
        Condition: {
          StringEquals: { "iam:AWSServiceName": "dsql.amazonaws.com" },
        },
      },
    ],
  });
}

/** Runtime policy attached permanently to a per-app role (not temp). */
export function buildRuntimePolicy(
  stackPrefix: string,
  appId: string,
  sharedTypeIds: string[],
  hasWriteAccess: boolean,
  canIngestUnknown: boolean,
  canPromoteFromUnknown: boolean,
): string {
  const s3SharedResources: string[] = [];
  for (const typeId of sharedTypeIds) {
    s3SharedResources.push(
      `arn:aws:s3:::${stackPrefix}-files-*/shared/${typeId}/*`,
    );
  }
  if (canIngestUnknown) {
    s3SharedResources.push(`arn:aws:s3:::${stackPrefix}-files-*/shared/unknown/*`);
  }
  if (canPromoteFromUnknown) {
    s3SharedResources.push(`arn:aws:s3:::${stackPrefix}-files-*/shared/unknown/*`);
  }

  const statements: object[] = [
    {
      Sid: "AppS3OwnPrefix",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      Resource: `arn:aws:s3:::${stackPrefix}-files-*/apps/${appId}/*`,
    },
    {
      // ListBucket is a bucket-level action. The s3:prefix condition restricts
      // enumeration to the app's own prefix; cross-prefix listing (other apps'
      // keys, foreign shared/* prefixes) is denied.
      Sid: "AppS3ListOwnPrefix",
      Effect: "Allow",
      Action: "s3:ListBucket",
      Resource: `arn:aws:s3:::${stackPrefix}-files-*`,
      Condition: {
        StringLike: { "s3:prefix": [`apps/${appId}/*`] },
      },
    },
    {
      Sid: "AppDsqlConnect",
      Effect: "Allow",
      Action: "dsql:DbConnect",
      Resource: "*",
    },
    {
      Sid: "AppInvokeOwnLambdas",
      Effect: "Allow",
      Action: "lambda:InvokeFunction",
      Resource: `arn:aws:lambda:*:*:function:${stackPrefix}-app-${appId}-*`,
    },
    {
      Sid: "AppLogWrites",
      Effect: "Allow",
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Resource: `arn:aws:logs:*:*:log-group:/aws/lambda/${stackPrefix}-app-${appId}-*`,
    },
  ];

  if (s3SharedResources.length > 0) {
    const s3Actions: string[] = ["s3:GetObject"];
    if (hasWriteAccess || canIngestUnknown) s3Actions.push("s3:PutObject", "s3:DeleteObject");
    if (canPromoteFromUnknown) s3Actions.push("s3:GetObject", "s3:DeleteObject", "s3:CopyObject");
    statements.push({
      Sid: "AppS3SharedData",
      Effect: "Allow",
      Action: [...new Set(s3Actions)],
      Resource: [...new Set(s3SharedResources)],
    });
  }

  return JSON.stringify({ Version: "2012-10-17", Statement: statements });
}
