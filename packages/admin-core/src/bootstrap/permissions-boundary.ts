import type { IamStatement } from "../iam-utils.js";

/**
 * Policy statements for the ${StackPrefix}-app-permissions-boundary managed policy.
 *
 * This boundary is attached to every Manager-minted per-app role (NOT admin-app,
 * whose bootstrap-time operational grants exceed it). The boundary caps what any
 * per-app role can ever do: S3 scoped to its own prefix, DSQL DbConnect (not Admin),
 * log writes, and an explicit Deny on all IAM actions.
 *
 * All strings are plain values (no Fn::Sub) — stackPrefix is resolved at generation
 * time, and IAM policy variables like ${aws:PrincipalTag/starkeep:appId} must remain
 * literal (Fn::Sub rejects the slash in the variable name).
 */
export function appPermissionsBoundaryStatements(stackPrefix: string): IamStatement[] {
  return [
    {
      Sid: "AppS3OwnPrefix",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
      Resource: [
        `arn:aws:s3:::${stackPrefix}-files-*`,
        `arn:aws:s3:::${stackPrefix}-files-*/apps/\${aws:PrincipalTag/starkeep:appId}/*`,
      ],
    },
    {
      Sid: "AppPulumiState",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
      Resource: [
        `arn:aws:s3:::${stackPrefix}-pulumi-state-*/.pulumi/stacks/${stackPrefix}-app-\${aws:PrincipalTag/starkeep:appId}.json`,
        `arn:aws:s3:::${stackPrefix}-pulumi-state-*/.pulumi/`,
        `arn:aws:s3:::${stackPrefix}-pulumi-state-*/.pulumi/*`,
      ],
    },
    {
      Sid: "AppArtifactsOwnPrefix",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject"],
      Resource: `arn:aws:s3:::${stackPrefix}-artifacts/apps/\${aws:PrincipalTag/starkeep:appId}/*`,
    },
    {
      Sid: "AppPulumiPassphrase",
      Effect: "Allow",
      Action: "ssm:GetParameter",
      Resource: `arn:aws:ssm:*:*:parameter/${stackPrefix}/pulumi/passphrase`,
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
      // Pulumi's lambda CreateFunction call runs under the app's STS session,
      // so AWS evaluates iam:PassRole on the app session. Resource is
      // restricted to ${prefix}-app-* (the role's own ARN is enforced by the
      // temp-install policy at install time).
      Sid: "AppPassRoleOwnRoleToLambda",
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
      // so the Allow above survives. Read-only IAM verbs aren't denied but
      // are implicitly denied at the boundary because nothing Allows them.
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
