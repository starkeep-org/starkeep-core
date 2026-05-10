import type { IamStatement, CfnValue } from "../iam-utils.js";

const SUB = (s: string): CfnValue => ({ Sub: s });

/**
 * Inline policy statements for the ${StackPrefix}-manager-role.
 *
 * Manager is pure delegation: it can mint/revoke per-app IAM roles (within the
 * permissions boundary) and attach temporary install/uninstall policies, but it
 * holds no standing power to read or write user data.
 */
export function managerPolicyStatements(stackPrefix: string): IamStatement[] {
  return [
    {
      Sid: "ManagerCreateDeleteAppRoles",
      Effect: "Allow",
      Action: [
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:UpdateRole",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
      ],
      Resource: SUB(
        `arn:aws:iam::*:role/${stackPrefix}-app-*`,
      ),
      Condition: {
        StringEquals: {
          "iam:PermissionsBoundary": SUB(
            `arn:aws:iam::*:policy/${stackPrefix}-app-permissions-boundary`,
          ),
        },
      },
    },
    {
      Sid: "ManagerPutDeleteAppRolePolicies",
      Effect: "Allow",
      Action: ["iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy"],
      Resource: SUB(`arn:aws:iam::*:role/${stackPrefix}-app-*`),
    },
    {
      Sid: "ManagerPassRoleToLambda",
      Effect: "Allow",
      Action: "iam:PassRole",
      Resource: SUB(`arn:aws:iam::*:role/${stackPrefix}-app-*`),
      Condition: {
        StringEquals: {
          "iam:PassedToService": "lambda.amazonaws.com",
        },
      },
    },
    {
      Sid: "ManagerAssumeAppRoles",
      Effect: "Allow",
      Action: "sts:AssumeRole",
      Resource: SUB(`arn:aws:iam::*:role/${stackPrefix}-app-*`),
    },
    {
      Sid: "ManagerGetCallerIdentity",
      Effect: "Allow",
      Action: "sts:GetCallerIdentity",
      Resource: "*",
    },
  ];
}
