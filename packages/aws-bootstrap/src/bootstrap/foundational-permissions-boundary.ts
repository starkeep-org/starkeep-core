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
 * cloud-data-server prefix, CloudFront admin (the platform distribution +
 * URL-signing key material), the CUR report definition API, and a single
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
        // Every bucket-level *read*, as one wildcard.
        //
        // Enumerating these individually pushed this policy past AWS's
        // 6144-character managed-policy ceiling, and the enumeration was buying
        // nothing: all seventeen were already granted, Pulumi's BucketV2 reads
        // most of them on every refresh, and the list only ever grew.
        //
        // The safety property that makes the wildcard sound is the Resource
        // below: **bucket ARNs only, never `bucket/*`**. Object actions like
        // `s3:GetObject` require an object ARN, so they cannot match this
        // statement however the wildcard expands — including for read actions
        // AWS adds in future. What it admits is reading our own two buckets'
        // configuration, which every enumerated entry already admitted.
        //
        // This is the *ceiling*, not a grant. The install-time temp policy
        // still enumerates exactly what it needs, so widening here does not
        // widen what any identity actually holds.
        "s3:Get*",
        // Writes stay enumerated. A `s3:Put*` here would admit
        // PutBucketPolicy-class changes nobody has asked for, and the whole
        // point of a boundary is that the dangerous half is explicit.
        "s3:PutBucketCORS",
        "s3:PutBucketPolicy",
        "s3:DeleteBucketPolicy",
        "s3:PutBucketTagging",
        "s3:PutBucketVersioning",
        "s3:PutBucketPublicAccessBlock",
        "s3:PutBucketOwnershipControls",
        "s3:PutEncryptionConfiguration",
        // Creating the files bucket with `objectLockEnabled` requires this in
        // addition to CreateBucket and PutBucketVersioning — AWS treats the
        // creation-time flag as writing the lock configuration. The flag only:
        // a bucket-level default retention is never written.
        "s3:PutBucketObjectLockConfiguration",
        // The single tag-filtered Deep Archive rule (media plan item 18).
        "s3:PutLifecycleConfiguration",
        // The availability machinery (media plan items 19/19b): the event
        // subscription that keeps stored availability true, and the daily
        // inventory that backstops it. Both are writes, so neither rides the
        // `s3:Get*` wildcard above — a boundary that omits them caps the
        // install below what the temp policy grants and the apply 403s.
        "s3:PutBucketNotification",
        "s3:PutInventoryConfiguration",
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
      // The two SSM parameters this role reads with ssm:GetParameter, merged
      // into one statement (union of resources) to conserve managed-policy
      // size:
      //  - /pulumi/passphrase: the Pulumi state-encryption passphrase.
      //  - /app-creds/*: per-app HMAC secrets — cloud-data-server reads any
      //    app's creds to verify HMAC-signed /apps/{appId}/* requests. The
      //    role's broker-power inline policy grants the same; the boundary
      //    admits it so the intersection holds at runtime.
      Sid: "FoundationalReadSsmParameters",
      Effect: "Allow",
      Action: "ssm:GetParameter",
      Resource: [
        `arn:aws:ssm:*:*:parameter/${stackPrefix}/pulumi/passphrase`,
        `arn:aws:ssm:*:*:parameter/${stackPrefix}/app-creds/*`,
      ],
    },
    {
      // SecureString decrypt for the two SSM SecureStrings this role reads
      // (both parameters in FoundationalReadSsmParameters — the Pulumi state
      // passphrase and the per-app HMAC creds). Both decrypt via the SSM
      // service key, so a single kms:ViaService-scoped statement covers both —
      // folded together to keep this boundary under the 6144-char
      // managed-policy size limit.
      Sid: "FoundationalSsmSecureStringKmsDecrypt",
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
        // The broker Lambda declares reservedConcurrentExecutions; AWS sets it
        // via a separate PutFunctionConcurrency call (create and update alike).
        "lambda:PutFunctionConcurrency",
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
      // Platform-owned CloudFront distribution (the CDS Pulumi program creates
      // the distribution, its S3-origin OAC, the shared-files cache policy, and
      // the URL-signing public key + key group). CloudFront is a global service
      // whose actions almost all authorize against Resource:"*" (public keys,
      // key groups, OAC, cache policies, and all List/Create calls have no
      // resource-level ARN), so a wildcard is the only workable boundary form —
      // matching how DsqlCluster/Cur/ApiGateway are capped above. This is the
      // *ceiling*: at steady state nothing grants cloudfront:* (the temp-install
      // policy carrying the specific verbs is detached after install), so the
      // effective standing CloudFront power of the CDS role is none. Kept as a
      // single compact statement to stay under the 6144-char managed-policy
      // limit.
      Sid: "FoundationalCloudFront",
      Effect: "Allow",
      Action: "cloudfront:*",
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
