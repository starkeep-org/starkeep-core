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
    // Two kinds of session reach a per-app role. The broker's carries the
    // `starkeep:userId` session tag of the user a request acts for, and
    // reaches that user's objects only. Manager's install and uninstall
    // sessions carry no user, and reach the app's own prefix as a whole: the
    // `.keep` marker, and every user's files when the app is uninstalled.
    // Neither reaches another user's objects or the shared prefix untagged.
    {
      // Per-object verbs on one user's part of apps/<appId>/.
      Sid: "AppS3OwnUserPrefix",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      Resource: `arn:aws:s3:::${stackPrefix}-files-*/apps/\${aws:PrincipalTag/starkeep:appId}/\${aws:PrincipalTag/starkeep:userId}/*`,
    },
    {
      // The whole of apps/<appId>/, for a session that names no user.
      Sid: "AppS3OwnPrefixNoUser",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      Resource: `arn:aws:s3:::${stackPrefix}-files-*/apps/\${aws:PrincipalTag/starkeep:appId}/*`,
      Condition: { Null: { "aws:PrincipalTag/starkeep:userId": "true" } },
    },
    {
      // ListBucket is a bucket-level action — AWS evaluates it against the
      // bucket ARN, not the object key. We add an s3:prefix Condition so a
      // per-app role cannot enumerate other apps' keys (G9g), nor another
      // user's. A user's session lists its own part of the app's prefix and
      // of the shared root.
      Sid: "AppS3ListOwnAndShared",
      Effect: "Allow",
      Action: "s3:ListBucket",
      Resource: `arn:aws:s3:::${stackPrefix}-files-*`,
      Condition: {
        StringLike: {
          "s3:prefix": [
            `apps/\${aws:PrincipalTag/starkeep:appId}/\${aws:PrincipalTag/starkeep:userId}/*`,
            `shared/\${aws:PrincipalTag/starkeep:userId}/*`,
          ],
        },
      },
    },
    {
      // Uninstall enumerates the app's whole prefix to delete it.
      Sid: "AppS3ListOwnPrefixNoUser",
      Effect: "Allow",
      Action: "s3:ListBucket",
      Resource: `arn:aws:s3:::${stackPrefix}-files-*`,
      Condition: {
        StringLike: { "s3:prefix": [`apps/\${aws:PrincipalTag/starkeep:appId}/*`] },
        Null: { "aws:PrincipalTag/starkeep:userId": "true" },
      },
    },
    {
      // One user's shared data. Per-category narrowing lives in
      // buildRuntimePolicy's AppS3SharedData Sid; the boundary permits the
      // session's own user's shared root so the runtime grants are reachable
      // through the ceiling (G2). A session that names no user reaches none.
      Sid: "AppS3SharedData",
      Effect: "Allow",
      Action: [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:CopyObject",
        // The archive pair (media plan items 17/19): tagging an original for
        // the Deep Archive lifecycle rule, and thawing one that has already
        // transitioned. Both act on shared originals, so both belong at the
        // same shared/* ceiling as the object verbs above.
        "s3:PutObjectTagging",
        "s3:RestoreObject",
      ],
      Resource: `arn:aws:s3:::${stackPrefix}-files-*/shared/\${aws:PrincipalTag/starkeep:userId}/*`,
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
      // Per-app HMAC credential reads. The boundary permits any per-app
      // role to read parameters under /${stackPrefix}/app-creds/*; the
      // role's inline runtime policy narrows it to the role's own parameter
      // via aws:PrincipalTag/starkeep:appId. Broker roles (cloud-data-server)
      // need to read every app's creds, which their runtime policy allows
      // through this same ceiling.
      Sid: "AppReadAppCreds",
      Effect: "Allow",
      Action: "ssm:GetParameter",
      Resource: `arn:aws:ssm:*:*:parameter/${stackPrefix}/app-creds/*`,
    },
    {
      Sid: "AppReadAppCredsKmsDecrypt",
      Effect: "Allow",
      Action: "kms:Decrypt",
      Resource: "*",
      Condition: {
        StringLike: { "kms:ViaService": "ssm.*.amazonaws.com" },
      },
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
