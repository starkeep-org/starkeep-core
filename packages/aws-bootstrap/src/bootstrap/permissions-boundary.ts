import type { IamStatement } from "../iam-utils.js";

/**
 * Policy statements for the ${StackPrefix}-app-permissions-boundary managed policy.
 *
 * This boundary is attached to every Manager-minted per-app role (NOT admin-app,
 * whose bootstrap-time operational grants exceed it). It caps what any per-app
 * role can ever do at *runtime*: per-app S3 prefix on the files bucket, shared
 * S3 root, DSQL DbConnect (not Admin), log writes to the app's own log group,
 * and lambda:InvokeFunction on the app's own functions. All install-time
 * provisioning power (Lambda admin, log-group admin, API Gateway admin,
 * Pulumi state write, iam:PassRole) lives on the install-infra-role instead;
 * Manager grants it ephemerally during install/uninstall via temp policies on
 * that role, never on this one.
 *
 * All strings are plain values (no Fn::Sub) — stackPrefix is resolved at
 * generation time, and IAM policy variables like
 * ${aws:PrincipalTag/starkeep:appId} must remain literal (Fn::Sub rejects the
 * slash in the variable name).
 */
export function appPermissionsBoundaryStatements(stackPrefix: string): IamStatement[] {
  return [
    {
      // Per-object verbs scoped to apps/<appId>/* on any files bucket.
      Sid: "AppS3OwnPrefix",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      Resource: `arn:aws:s3:::${stackPrefix}-files-*/apps/\${aws:PrincipalTag/starkeep:appId}/*`,
    },
    {
      // ListBucket is a bucket-level action — AWS evaluates it against the
      // bucket ARN, not the object key. We add an s3:prefix Condition so a
      // per-app role cannot enumerate other apps' keys (G9g). Two prefixes
      // are permitted: the app's own prefix and the shared root.
      Sid: "AppS3ListOwnAndShared",
      Effect: "Allow",
      Action: "s3:ListBucket",
      Resource: `arn:aws:s3:::${stackPrefix}-files-*`,
      Condition: {
        StringLike: {
          "s3:prefix": [
            `apps/\${aws:PrincipalTag/starkeep:appId}/*`,
            "shared/*",
          ],
        },
      },
    },
    {
      // Shared-data root. Per-typeId narrowing lives in buildRuntimePolicy's
      // AppS3SharedData Sid; the boundary just permits the shared/* root so
      // the runtime grants are reachable through the ceiling (G2).
      Sid: "AppS3SharedData",
      Effect: "Allow",
      Action: [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:CopyObject",
      ],
      Resource: `arn:aws:s3:::${stackPrefix}-files-*/shared/*`,
    },
    {
      Sid: "AppDsqlConnect",
      Effect: "Allow",
      Action: "dsql:DbConnect",
      Resource: "*",
    },
    {
      Sid: "AppLogWrites",
      Effect: "Allow",
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Resource: `arn:aws:logs:*:*:log-group:/aws/lambda/${stackPrefix}-app-*`,
    },
    {
      // Per-app Lambdas may invoke each other (e.g. an app's API handler
      // fanning out to its static handler). Scoped to the same app's
      // function ARNs at runtime via the inline runtime policy; the boundary
      // permits any same-prefix invocation as the ceiling.
      Sid: "AppInvokeOwnLambdas",
      Effect: "Allow",
      Action: "lambda:InvokeFunction",
      Resource: `arn:aws:lambda:*:*:function:${stackPrefix}-app-*`,
    },
    {
      // Defense-in-depth: deny every mutating IAM verb. Read-only IAM verbs
      // aren't denied but are implicitly denied at the boundary because
      // nothing Allows them.
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
