import type { IamStatement } from "../iam-utils.js";

/**
 * Policy statements for the ${StackPrefix}-install-infra-permissions-boundary
 * managed policy.
 *
 * This boundary caps the install-infra-role, the centralized identity that
 * Manager temporarily elevates to provision per-app AWS resources (Lambda,
 * CloudWatch log groups, API Gateway v2 integrations/routes, Pulumi stack
 * state) during install/uninstall. It is the parallel of install-ddl-role:
 * a Manager-trusted role with no standing power, granted ephemeral per-app
 * temp policies.
 *
 * The boundary is wider than any individual install (any per-app temp policy
 * narrows the resource ARNs to a specific appId), but it is still narrowly
 * scoped to per-app Lambda/log-group name patterns and the well-known Pulumi
 * state bucket. No data-plane access (S3 files bucket, DSQL connect) is
 * permitted here — those remain on per-app runtime roles.
 *
 * Like the install-ddl boundary, every mutating IAM verb is explicitly denied
 * via defense-in-depth.
 */
export function installInfraBoundaryStatements(stackPrefix: string): IamStatement[] {
  return [
    {
      // Pulumi state backend lives in this bucket; install-infra reads/writes
      // each app's stack state file plus the shared .pulumi/ metadata.
      // GetAccelerateConfiguration is used as the IAM-propagation probe by
      // compute-stack.ts's probePulumiStateBucket().
      Sid: "InstallInfraPulumiState",
      Effect: "Allow",
      Action: [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetAccelerateConfiguration",
      ],
      Resource: [
        `arn:aws:s3:::${stackPrefix}-pulumi-state-*`,
        `arn:aws:s3:::${stackPrefix}-pulumi-state-*/.pulumi/`,
        `arn:aws:s3:::${stackPrefix}-pulumi-state-*/.pulumi/*`,
      ],
    },
    {
      Sid: "InstallInfraPulumiPassphrase",
      Effect: "Allow",
      Action: "ssm:GetParameter",
      Resource: `arn:aws:ssm:*:*:parameter/${stackPrefix}/pulumi/passphrase`,
    },
    {
      // Artifacts bucket: install-infra uploads each app's deployment bundle
      // (uploadAppBundle) and Pulumi's aws.lambda.Function sources Lambda
      // code from the same key.
      Sid: "InstallInfraArtifacts",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
      Resource: [
        // Bucket name is suffixed with account+region (see bootstrap CFN
        // ArtifactsBucket); wildcard absorbs the suffix.
        `arn:aws:s3:::${stackPrefix}-artifacts-*`,
        `arn:aws:s3:::${stackPrefix}-artifacts-*/apps/*`,
      ],
    },
    {
      // Full Lambda admin on per-app function ARNs. AddPermission/GetPolicy
      // are required to attach the API-Gateway-invoke resource policy
      // statement that Pulumi's aws.lambda.Permission resource creates. The
      // refresh-time reads (ListVersionsByFunction, GetFunction*Config, etc.)
      // are fired by Pulumi on every BucketV2-style refresh.
      Sid: "InstallInfraLambda",
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
        "lambda:GetRuntimeManagementConfig",
      ],
      Resource: `arn:aws:lambda:*:*:function:${stackPrefix}-app-*`,
    },
    {
      Sid: "InstallInfraLogs",
      Effect: "Allow",
      Action: [
        "logs:CreateLogGroup",
        "logs:DeleteLogGroup",
        "logs:PutRetentionPolicy",
        "logs:TagResource",
        "logs:UntagResource",
        "logs:ListTagsForResource",
      ],
      Resource: `arn:aws:logs:*:*:log-group:/aws/lambda/${stackPrefix}-app-*`,
    },
    {
      // List-level action — see TempInstallLogsList in temp-policies.ts.
      Sid: "InstallInfraLogsList",
      Effect: "Allow",
      Action: "logs:DescribeLogGroups",
      Resource: "*",
    },
    {
      // Per-app HTTP API integrations/routes attach to the shared API Gateway
      // owned by cloud-data-server. install-infra never creates/deletes the
      // Api, Authorizer, or Stage itself — only integrations and routes. We
      // keep the boundary aligned with the temp policy: Integration/Route
      // verbs + tagging.
      Sid: "InstallInfraApiGatewayV2",
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
      // v2 HTTP API integration/route create paths and tagging authorize
      // against the legacy `apigateway` IAM namespace with REST-method
      // action names. The pulumi-aws provider issues these against the
      // `/apis/{api-id}/{integrations,routes,...}` paths rather than `/v2/*`,
      // so the boundary must allow `/apis/*`. `/v2/*` is kept for the rarer
      // direct v2-namespace paths.
      Sid: "InstallInfraApiGatewayLegacy",
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
      // Pulumi's lambda.Function CreateFunction passes the app's per-app role
      // as the Lambda execution role. install-infra is the principal making
      // that call, so AWS evaluates iam:PassRole on this boundary.
      Sid: "InstallInfraPassRoleAppToLambda",
      Effect: "Allow",
      Action: "iam:PassRole",
      Resource: `arn:aws:iam::*:role/${stackPrefix}-app-*`,
      Condition: {
        StringEquals: {
          "iam:PassedToService": "lambda.amazonaws.com",
        },
      },
    },
    {
      // Defense-in-depth: deny every mutating IAM verb. PassRole is omitted
      // from the prefix list so the Allow above survives.
      Sid: "DenyOtherIam",
      Effect: "Deny",
      Action: [
        "iam:Add*",
        "iam:Attach*",
        "iam:Change*",
        "iam:Create*",
        "iam:Deactivate*",
        "iam:Delete*",
        "iam:Detach*",
        "iam:Enable*",
        "iam:Generate*",
        "iam:Put*",
        "iam:Remove*",
        "iam:Reset*",
        "iam:Resync*",
        "iam:Set*",
        "iam:Tag*",
        "iam:Untag*",
        "iam:Update*",
        "iam:Upload*",
      ],
      Resource: "*",
    },
  ];
}
