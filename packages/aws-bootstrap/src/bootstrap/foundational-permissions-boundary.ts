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
        "s3:GetBucketWebsite",
        // Pulumi's aws.s3.BucketV2 reads these on every refresh; without them
        // every CDS install eats AccessDenied warnings or hard refresh
        // failures (G6a).
        "s3:GetAccelerateConfiguration",
        "s3:GetBucketLogging",
        "s3:GetBucketRequestPayment",
        "s3:GetBucketObjectLockConfiguration",
        "s3:GetReplicationConfiguration",
        "s3:GetLifecycleConfiguration",
        "s3:GetBucketNotification",
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
        // cds bundle is shipped via pulumi.asset.FileArchive (Pulumi's own
        // asset machinery uploads it as part of stack state), not via the
        // cds role PUTing to the artifacts bucket — so no artifacts grant
        // is needed here. If cds ever switches to S3-sourced Lambda code,
        // re-add an `${stackPrefix}-artifacts-*/apps/${cdsAppId}/*` resource.
      ],
    },
    {
      Sid: "FoundationalPulumiState",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:GetAccelerateConfiguration"],
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
      // The passphrase parameter is a SecureString; decrypt is via the SSM
      // service key. Scoped via kms:ViaService.
      Sid: "FoundationalPulumiPassphraseKmsDecrypt",
      Effect: "Allow",
      Action: "kms:Decrypt",
      Resource: "*",
      Condition: {
        StringLike: { "kms:ViaService": "ssm.*.amazonaws.com" },
      },
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
        // Refresh-time reads fired by Pulumi's aws.lambda.Function on every
        // refresh (G6b, G9k).
        "lambda:ListVersionsByFunction",
        "lambda:GetFunctionCodeSigningConfig",
        "lambda:GetFunctionConcurrency",
        "lambda:GetFunctionUrlConfig",
        "lambda:ListFunctionEventInvokeConfigs",
        "lambda:GetRuntimeManagementConfig",
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
      // apigatewayv2:*. CreateApi is evaluated against /apis (not /v2/apis),
      // so both the un-prefixed and v2-prefixed path forms are required.
      Sid: "FoundationalApiGatewayRestActions",
      Effect: "Allow",
      Action: [
        "apigateway:GET",
        "apigateway:POST",
        "apigateway:PATCH",
        "apigateway:PUT",
        "apigateway:DELETE",
        // v2 tagging on stages/integrations/routes fires under the legacy
        // namespace (G6c).
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
      Sid: "FoundationalCur",
      Effect: "Allow",
      Action: [
        "cur:PutReportDefinition",
        "cur:DescribeReportDefinitions",
        "cur:DeleteReportDefinition",
        // Pulumi's CUR resource reads/writes tags on every refresh (G6d).
        "cur:ListTagsForResource",
        "cur:TagResource",
        "cur:UntagResource",
      ],
      Resource: "*",
    },
    {
      // First-ever dsql:CreateCluster in an account often needs the DSQL
      // service-linked role created. AWS auto-creates SLRs when the caller
      // holds iam:CreateServiceLinkedRole for the matching service. Scoped
      // to the DSQL service principal so the FoundationalDenyOtherIam
      // NotAction carve-out doesn't admit anything else (G9i).
      Sid: "FoundationalIamCreateServiceLinkedRole",
      Effect: "Allow",
      Action: "iam:CreateServiceLinkedRole",
      Resource: "*",
      Condition: {
        StringEquals: {
          "iam:AWSServiceName": "dsql.amazonaws.com",
        },
      },
    },
    {
      // Broker pattern: cloud-data-server assumes the caller's per-app role on
      // every sync request to act under that app's identity. The role's inline
      // `broker-power` policy grants the same action; without this matching
      // statement in the boundary, the intersection cap denies AssumeRole at
      // runtime and every /apps/{appId}/sync/{pull,push} ends in 403.
      Sid: "FoundationalBrokerAssumeAppRoles",
      Effect: "Allow",
      Action: "sts:AssumeRole",
      Resource: `arn:aws:iam::*:role/${stackPrefix}-app-*`,
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
      // Defense-in-depth: deny every mutating IAM verb except the two we
      // explicitly Allow above (iam:PassRole, iam:CreateServiceLinkedRole
      // gated on dsql.amazonaws.com). iam:Create* is enumerated as the
      // explicit subverbs rather than the wildcard so CreateServiceLinkedRole
      // isn't accidentally caught (G9i). Read-only iam:Get*/List* are not
      // denied — they remain implicitly denied because nothing Allows them.
      Sid: "FoundationalDenyOtherIam",
      Effect: "Deny",
      Action: [
        "iam:Add*",
        "iam:Attach*",
        "iam:Change*",
        "iam:CreateAccessKey",
        "iam:CreateAccountAlias",
        "iam:CreateGroup",
        "iam:CreateInstanceProfile",
        "iam:CreateLoginProfile",
        "iam:CreateOpenIDConnectProvider",
        "iam:CreatePolicy",
        "iam:CreatePolicyVersion",
        "iam:CreateRole",
        "iam:CreateSAMLProvider",
        "iam:CreateUser",
        "iam:CreateVirtualMFADevice",
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
