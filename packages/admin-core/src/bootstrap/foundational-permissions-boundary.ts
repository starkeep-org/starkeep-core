import type { IamStatement } from "../iam-utils.js";

/**
 * Policy statements for the ${StackPrefix}-foundational-permissions-boundary
 * managed policy.
 *
 * This boundary is attached only to roles that perform foundational, one-time
 * infrastructure provisioning that the regular per-app boundary intentionally
 * forbids — currently just ${StackPrefix}-app-cloud-data-server-role. It
 * permits DSQL cluster admin, S3 bucket admin on the well-known foundational
 * bucket name patterns, Lambda/log-group/API-Gateway admin scoped to the
 * cloud-data-server prefix, the CUR report definition API, and a single
 * PassRole carve-out (own role, lambda only). All other iam:* actions stay
 * denied via the NotAction carve-out, so a future temp-policy bug cannot
 * accidentally grant broader IAM.
 *
 * Cloud-data-server is the sole foundational app and is always installed
 * before any other app, which is why a single magic-string check in
 * createAppRole is sufficient to route the boundary correctly.
 */
export function foundationalPermissionsBoundaryStatements(
  stackPrefix: string,
): IamStatement[] {
  const cdsAppId = "cloud-data-server";

  const apigatewayv2Verbs = [
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
  ];

  return [
    {
      Sid: "FoundationalDsqlCluster",
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
        "dsql:DbConnect",
        "dsql:DbConnectAdmin",
      ],
      Resource: "*",
    },
    {
      Sid: "FoundationalS3Buckets",
      Effect: "Allow",
      Action: [
        "s3:CreateBucket",
        "s3:DeleteBucket",
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:GetBucketAcl",
        "s3:GetBucketCORS",
        "s3:PutBucketCORS",
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
      ],
      Resource: [
        `arn:aws:s3:::${stackPrefix}-files-*`,
        `arn:aws:s3:::${stackPrefix}-billing-*`,
      ],
    },
    {
      Sid: "FoundationalS3Objects",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      Resource: [
        `arn:aws:s3:::${stackPrefix}-files-*/*`,
        `arn:aws:s3:::${stackPrefix}-billing-*/*`,
        `arn:aws:s3:::${stackPrefix}-artifacts/apps/${cdsAppId}/*`,
      ],
    },
    {
      Sid: "FoundationalPulumiState",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
      Resource: [
        `arn:aws:s3:::${stackPrefix}-pulumi-state-*`,
        `arn:aws:s3:::${stackPrefix}-pulumi-state-*/.pulumi/`,
        `arn:aws:s3:::${stackPrefix}-pulumi-state-*/.pulumi/*`,
      ],
    },
    {
      Sid: "FoundationalPulumiPassphrase",
      Effect: "Allow",
      Action: "ssm:GetParameter",
      Resource: `arn:aws:ssm:*:*:parameter/${stackPrefix}/pulumi/passphrase`,
    },
    {
      Sid: "FoundationalLambda",
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
        "lambda:InvokeFunction",
      ],
      Resource: `arn:aws:lambda:*:*:function:${stackPrefix}-app-${cdsAppId}-*`,
    },
    {
      Sid: "FoundationalLogs",
      Effect: "Allow",
      Action: [
        "logs:CreateLogGroup",
        "logs:DeleteLogGroup",
        "logs:PutRetentionPolicy",
        "logs:TagResource",
        "logs:UntagResource",
        "logs:ListTagsForResource",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
      ],
      Resource: `arn:aws:logs:*:*:log-group:/aws/lambda/${stackPrefix}-app-${cdsAppId}-*`,
    },
    {
      // DescribeLogGroups is a list-level action — AWS evaluates it against
      // the all-zeros resource arn:aws:logs:…:log-group::log-stream:, so it
      // must be granted on Resource:"*" regardless of which group we want
      // to filter for in the API call.
      Sid: "FoundationalLogsList",
      Effect: "Allow",
      Action: ["logs:DescribeLogGroups"],
      Resource: "*",
    },
    {
      Sid: "FoundationalApiGateway",
      Effect: "Allow",
      Action: apigatewayv2Verbs,
      Resource: "*",
    },
    {
      // API Gateway v2 (HTTP APIs) tagging and several create paths still
      // authorize against the legacy `apigateway` IAM service namespace
      // using REST-method action names (apigateway:GET/POST/…), not
      // apigatewayv2:*. Without this, CreateApi fails on the tag write.
      Sid: "FoundationalApiGatewayRestActions",
      Effect: "Allow",
      Action: [
        "apigateway:GET",
        "apigateway:POST",
        "apigateway:PATCH",
        "apigateway:PUT",
        "apigateway:DELETE",
      ],
      Resource: [
        "arn:aws:apigateway:*::/v2/*",
        "arn:aws:apigateway:*::/tags/*",
      ],
    },
    {
      Sid: "FoundationalCur",
      Effect: "Allow",
      Action: [
        "cur:PutReportDefinition",
        "cur:DescribeReportDefinitions",
        "cur:DeleteReportDefinition",
      ],
      Resource: "*",
    },
    {
      Sid: "FoundationalPassRoleOwnRoleToLambda",
      Effect: "Allow",
      Action: "iam:PassRole",
      Resource: `arn:aws:iam::*:role/${stackPrefix}-app-${cdsAppId}-role`,
      Condition: {
        StringEquals: {
          "iam:PassedToService": "lambda.amazonaws.com",
        },
      },
    },
    {
      // Defense-in-depth: deny every mutating IAM verb. PassRole is omitted
      // from the prefix list, so the Allow above survives. Read-only IAM
      // verbs (Get*/List*) aren't denied here but are implicitly denied at
      // the boundary because nothing Allows them.
      Sid: "FoundationalDenyOtherIam",
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
