/**
 * Temporary inline policies attached to an app role during install/uninstall.
 *
 * These are attached by Manager before the provisioning work begins and
 * detached immediately after. The permissions boundary still caps everything.
 */

export function buildTempInstallPolicy(
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
        Sid: "TempInstallS3AppPrefix",
        Effect: "Allow",
        Action: ["s3:PutObject", "s3:GetObject"],
        Resource: [
          `arn:aws:s3:::${stackPrefix}-files-*/apps/${appId}/*`,
          `arn:aws:s3:::${stackPrefix}-artifacts/apps/${appId}/*`,
        ],
      },
      {
        Sid: "TempInstallPulumiState",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
        Resource: [
          `arn:aws:s3:::${pulumiStateBucket}/.pulumi/stacks/${stackPrefix}-app-${appId}.json`,
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
        Action: "dsql:DbConnectAdmin",
        Resource: "*",
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
        ],
        Resource: `arn:aws:lambda:*:${accountId}:function:${stackPrefix}-app-${appId}-*`,
      },
      {
        Sid: "TempInstallLogs",
        Effect: "Allow",
        Action: [
          "logs:CreateLogGroup",
          "logs:DeleteLogGroup",
          "logs:DescribeLogGroups",
          "logs:PutRetentionPolicy",
          "logs:TagResource",
          "logs:UntagResource",
          "logs:ListTagsForResource",
        ],
        Resource: `arn:aws:logs:*:${accountId}:log-group:/aws/lambda/${stackPrefix}-app-${appId}-*`,
      },
      {
        Sid: "TempInstallApiGateway",
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
        // Pulumi's lambda.Function resource runs CreateFunction under the
        // app's STS session, so AWS evaluates iam:PassRole on this session.
        // Scoped to the app's own role only; the boundary's
        // AppPassRoleOwnRoleToLambda also caps PassRole to lambda.
        Sid: "TempInstallPassRoleOwnRoleToLambda",
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

export function buildTempUninstallPolicy(
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
        Sid: "TempUninstallS3AppPrefix",
        Effect: "Allow",
        Action: ["s3:DeleteObject", "s3:ListBucket", "s3:GetObject"],
        Resource: [
          `arn:aws:s3:::${stackPrefix}-files-*/apps/${appId}/*`,
          `arn:aws:s3:::${stackPrefix}-artifacts/apps/${appId}/*`,
        ],
      },
      {
        Sid: "TempUninstallPulumiState",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
        Resource: [
          `arn:aws:s3:::${pulumiStateBucket}/.pulumi/stacks/${stackPrefix}-app-${appId}.json`,
          `arn:aws:s3:::${pulumiStateBucket}/.pulumi/`,
          `arn:aws:s3:::${pulumiStateBucket}/.pulumi/*`,
        ],
      },
      {
        Sid: "TempUninstallSsmPassphrase",
        Effect: "Allow",
        Action: "ssm:GetParameter",
        Resource: `arn:aws:ssm:*:${accountId}:parameter/${stackPrefix}/pulumi/passphrase`,
      },
      {
        Sid: "TempUninstallDsqlAdmin",
        Effect: "Allow",
        Action: "dsql:DbConnectAdmin",
        Resource: "*",
      },
      {
        Sid: "TempUninstallLambda",
        Effect: "Allow",
        Action: [
          "lambda:DeleteFunction",
          "lambda:GetFunction",
          "lambda:GetFunctionConfiguration",
        ],
        Resource: `arn:aws:lambda:*:${accountId}:function:${stackPrefix}-app-${appId}-*`,
      },
      {
        Sid: "TempUninstallLogs",
        Effect: "Allow",
        Action: ["logs:DeleteLogGroup", "logs:DescribeLogGroups"],
        Resource: `arn:aws:logs:*:${accountId}:log-group:/aws/lambda/${stackPrefix}-app-${appId}-*`,
      },
      {
        Sid: "TempUninstallApiGateway",
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
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
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
        ],
        Resource: `arn:aws:lambda:*:${accountId}:function:${stackPrefix}-app-${appId}-*`,
      },
      {
        Sid: "TempInstallLogs",
        Effect: "Allow",
        Action: [
          "logs:CreateLogGroup",
          "logs:DeleteLogGroup",
          "logs:DescribeLogGroups",
          "logs:PutRetentionPolicy",
          "logs:TagResource",
          "logs:UntagResource",
          "logs:ListTagsForResource",
        ],
        Resource: `arn:aws:logs:*:${accountId}:log-group:/aws/lambda/${stackPrefix}-app-${appId}-*`,
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
        ],
        Resource: "*",
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
      `arn:aws:s3:::${stackPrefix}-files-*/shared/${typeId}/data/*`,
    );
  }
  if (canIngestUnknown) {
    s3SharedResources.push(`arn:aws:s3:::${stackPrefix}-files-*/shared/unknown/data/*`);
  }
  if (canPromoteFromUnknown) {
    s3SharedResources.push(`arn:aws:s3:::${stackPrefix}-files-*/shared/unknown/data/*`);
  }

  const statements: object[] = [
    {
      Sid: "AppS3OwnPrefix",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
      Resource: [
        `arn:aws:s3:::${stackPrefix}-files-*/apps/${appId}/*`,
      ],
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
