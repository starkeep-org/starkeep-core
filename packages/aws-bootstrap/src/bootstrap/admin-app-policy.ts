import type { IamStatement, CfnValue } from "../iam-utils.js";

const SUB = (s: string): CfnValue => ({ Sub: s });

/**
 * Inline policy statements for the ${StackPrefix}-app-admin-role.
 *
 * This is the federated entry point for the human user. It grants:
 *   - Admin-app-specific operations (Cognito, CodeBuild, artifacts bucket I/O)
 *   - The ability to assume Manager so installs can proceed
 *   - Standard per-app runtime grants scoped to the admin prefix
 *
 * It does NOT grant broad dsql:DbConnectAdmin, s3:* over the whole bucket, or
 * any IAM management actions — those would violate the single-tenant model.
 * The permissions boundary is NOT applied to admin-app (it's bootstrap-created),
 * but its inline policy is manually constrained to the same spirit.
 */
export function adminAppPolicyStatements(stackPrefix: string): IamStatement[] {
  return [
    {
      Sid: "AdminAppStsIdentity",
      Effect: "Allow",
      Action: "sts:GetCallerIdentity",
      Resource: "*",
    },
    {
      Sid: "AdminAppAssumeManager",
      Effect: "Allow",
      Action: "sts:AssumeRole",
      Resource: SUB(`arn:aws:iam::*:role/${stackPrefix}-manager-role`),
    },
    {
      Sid: "AdminAppCognito",
      Effect: "Allow",
      Action: [
        "cognito-idp:AdminCreateUser",
        "cognito-idp:AdminSetUserPassword",
        "cognito-idp:AdminGetUser",
        "cognito-idp:AdminDeleteUser",
        "cognito-idp:ListUsers",
        "cognito-idp:DescribeUserPool",
        "cognito-idp:DescribeUserPoolClient",
      ],
      Resource: { GetAtt: "UserPool.Arn" },
    },
    {
      Sid: "AdminAppS3ListOwnPrefix",
      Effect: "Allow",
      Action: "s3:ListBucket",
      Resource: SUB(`arn:aws:s3:::${stackPrefix}-files-*`),
      Condition: { StringLike: { "s3:prefix": "apps/admin/*" } },
    },
    {
      Sid: "AdminAppS3OwnPrefix",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      Resource: SUB(`arn:aws:s3:::${stackPrefix}-files-*/apps/admin/*`),
    },
    {
      Sid: "AdminAppS3ListBilling",
      Effect: "Allow",
      Action: "s3:ListBucket",
      Resource: SUB(`arn:aws:s3:::${stackPrefix}-billing-*`),
    },
    {
      Sid: "AdminAppS3ReadBilling",
      Effect: "Allow",
      Action: "s3:GetObject",
      Resource: SUB(`arn:aws:s3:::${stackPrefix}-billing-*/*`),
    },
    {
      Sid: "AdminAppDsqlConnect",
      Effect: "Allow",
      Action: "dsql:DbConnect",
      Resource: "*",
    },
    {
      Sid: "AdminAppLogWrites",
      Effect: "Allow",
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Resource: SUB(
        `arn:aws:logs:*:*:log-group:/aws/lambda/${stackPrefix}-app-admin-*`,
      ),
    },
    // The admin-installer creates /pulumi/passphrase as a SecureString on
    // first cloud-data-server install (CloudFormation can't create
    // SecureString SSM parameters itself). Create-if-missing thereafter —
    // the passphrase must stay stable once any Pulumi state exists. Read+
    // write are scoped to that one parameter.
    {
      Sid: "AdminAppEnsurePulumiPassphrase",
      Effect: "Allow",
      Action: ["ssm:GetParameter", "ssm:PutParameter", "ssm:AddTagsToResource"],
      Resource: SUB(
        `arn:aws:ssm:*:*:parameter/${stackPrefix}/pulumi/passphrase`,
      ),
    },
    {
      Sid: "AdminAppPulumiPassphraseKms",
      Effect: "Allow",
      Action: ["kms:Encrypt", "kms:Decrypt"],
      Resource: "*",
      Condition: {
        StringEquals: { "kms:ViaService": SUB("ssm.${AWS::Region}.amazonaws.com") },
      },
    },
  ];
}
