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
): string {
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
          `arn:aws:s3:::${stackPrefix}-pulumi-state-${accountId}/.pulumi/stacks/${stackPrefix}-app-${appId}.json`,
          `arn:aws:s3:::${stackPrefix}-pulumi-state-${accountId}/.pulumi/`,
          `arn:aws:s3:::${stackPrefix}-pulumi-state-${accountId}/.pulumi/*`,
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
          "lambda:UpdateFunctionCode",
          "lambda:UpdateFunctionConfiguration",
          "lambda:TagResource",
          "lambda:GetFunction",
          "lambda:DeleteFunction",
        ],
        Resource: `arn:aws:lambda:*:${accountId}:function:${stackPrefix}-app-${appId}-*`,
      },
      {
        Sid: "TempInstallLogs",
        Effect: "Allow",
        Action: ["logs:CreateLogGroup", "logs:PutRetentionPolicy", "logs:TagResource", "logs:DeleteLogGroup"],
        Resource: `arn:aws:logs:*:${accountId}:log-group:/aws/lambda/${stackPrefix}-app-${appId}-*`,
      },
      {
        Sid: "TempInstallApiGateway",
        Effect: "Allow",
        Action: ["apigatewayv2:CreateIntegration", "apigatewayv2:UpdateIntegration",
                 "apigatewayv2:DeleteIntegration", "apigatewayv2:GetIntegration",
                 "apigatewayv2:CreateRoute", "apigatewayv2:UpdateRoute",
                 "apigatewayv2:DeleteRoute", "apigatewayv2:GetRoute",
                 "apigatewayv2:GetRoutes", "apigatewayv2:GetIntegrations",
                 "apigatewayv2:GetApis"],
        Resource: "*",
      },
    ],
  });
}

export function buildTempUninstallPolicy(
  stackPrefix: string,
  appId: string,
  accountId: string,
): string {
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
          `arn:aws:s3:::${stackPrefix}-pulumi-state-${accountId}/.pulumi/stacks/${stackPrefix}-app-${appId}.json`,
          `arn:aws:s3:::${stackPrefix}-pulumi-state-${accountId}/.pulumi/`,
          `arn:aws:s3:::${stackPrefix}-pulumi-state-${accountId}/.pulumi/*`,
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
        Action: ["lambda:DeleteFunction", "lambda:GetFunction"],
        Resource: `arn:aws:lambda:*:${accountId}:function:${stackPrefix}-app-${appId}-*`,
      },
      {
        Sid: "TempUninstallLogs",
        Effect: "Allow",
        Action: ["logs:DeleteLogGroup"],
        Resource: `arn:aws:logs:*:${accountId}:log-group:/aws/lambda/${stackPrefix}-app-${appId}-*`,
      },
      {
        Sid: "TempUninstallApiGateway",
        Effect: "Allow",
        Action: ["apigatewayv2:DeleteIntegration", "apigatewayv2:DeleteRoute",
                 "apigatewayv2:GetRoute", "apigatewayv2:GetRoutes",
                 "apigatewayv2:GetIntegrations", "apigatewayv2:GetApis"],
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
