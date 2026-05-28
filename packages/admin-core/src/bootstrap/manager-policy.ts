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
      // CreateRole is the only action where AWS evaluates the
      // iam:PermissionsBoundary condition key — the rest of the
      // role-management verbs don't populate it, so gating them with this
      // condition would always deny. CreateRole alone is the actual security
      // bar: it ensures every Manager-minted role is born with one of the
      // two known boundaries (regular per-app or foundational). The choice
      // between them is centralized in createAppRole — IAM accepts either,
      // but only one code path (the magic-string check on appId) can pick
      // the foundational one.
      Sid: "ManagerCreateAppRoleWithBoundary",
      Effect: "Allow",
      Action: "iam:CreateRole",
      Resource: SUB(`arn:aws:iam::*:role/${stackPrefix}-app-*`),
      Condition: {
        // ArnLike (not StringEquals) — the policy ARNs contain a wildcard
        // for the account-id segment, and StringEquals would treat that '*'
        // as a literal character and never match a real ARN. ArnLike does
        // ARN-aware glob matching, so 'arn:aws:iam::*:policy/...' matches
        // 'arn:aws:iam::026090522855:policy/...' as intended.
        ArnLike: {
          "iam:PermissionsBoundary": [
            SUB(`arn:aws:iam::*:policy/${stackPrefix}-app-permissions-boundary`),
            SUB(`arn:aws:iam::*:policy/${stackPrefix}-foundational-permissions-boundary`),
          ],
        },
      },
    },
    {
      Sid: "ManagerManageAppRoles",
      Effect: "Allow",
      Action: [
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:UpdateRole",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
        // Needed to heal trust-policy RoleId drift when the manager role is
        // ever deleted and recreated (its AROA changes, leaving each app
        // role's existing trust policy pointing at the dead AROA).
        "iam:UpdateAssumeRolePolicy",
      ],
      Resource: SUB(`arn:aws:iam::*:role/${stackPrefix}-app-*`),
    },
    {
      Sid: "ManagerPutDeleteAppRolePolicies",
      Effect: "Allow",
      Action: ["iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy"],
      Resource: SUB(`arn:aws:iam::*:role/${stackPrefix}-app-*`),
    },
    {
      Sid: "ManagerAssumeAppRoles",
      Effect: "Allow",
      Action: "sts:AssumeRole",
      Resource: SUB(`arn:aws:iam::*:role/${stackPrefix}-app-*`),
    },
    {
      Sid: "ManagerPutDeleteInstallDdlRolePolicies",
      Effect: "Allow",
      Action: [
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:GetRolePolicy",
        // Enumerating policies on install-ddl-role is needed to sweep any
        // orphan temp-install-ddl-<appId> left by an interrupted run.
        "iam:ListRolePolicies",
      ],
      Resource: SUB(`arn:aws:iam::*:role/${stackPrefix}-install-ddl-role`),
    },
    {
      Sid: "ManagerAssumeInstallDdlRole",
      Effect: "Allow",
      Action: "sts:AssumeRole",
      Resource: SUB(`arn:aws:iam::*:role/${stackPrefix}-install-ddl-role`),
    },
    {
      Sid: "ManagerPutDeleteInstallInfraRolePolicies",
      Effect: "Allow",
      Action: [
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:GetRolePolicy",
        "iam:ListRolePolicies",
      ],
      Resource: SUB(`arn:aws:iam::*:role/${stackPrefix}-install-infra-role`),
    },
    {
      Sid: "ManagerAssumeInstallInfraRole",
      Effect: "Allow",
      Action: "sts:AssumeRole",
      Resource: SUB(`arn:aws:iam::*:role/${stackPrefix}-install-infra-role`),
    },
    {
      Sid: "ManagerGetCallerIdentity",
      Effect: "Allow",
      Action: "sts:GetCallerIdentity",
      Resource: "*",
    },
  ];
}
