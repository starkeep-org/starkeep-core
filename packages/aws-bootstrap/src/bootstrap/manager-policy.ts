import type { IamStatement, CfnValue } from "../iam-utils.js";
import { bedrockFreezeTargetRoleNames } from "../bedrock-budget-spec.js";

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
      // three known boundaries (regular per-app, foundational, or
      // user-data-owner). The choice between them is centralized in
      // createAppRole — IAM accepts any of them, but only one code path (the
      // magic-string check on appId) can pick the foundational or
      // user-data-owner one.
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
            SUB(`arn:aws:iam::*:policy/${stackPrefix}-user-data-owner-permissions-boundary`),
            // Capability broker (plan §3.3): the reserved-appId capability-broker
            // role is minted under its own Bedrock-invoke-only boundary.
            SUB(`arn:aws:iam::*:policy/${stackPrefix}-capability-broker-permissions-boundary`),
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
    {
      // Manage per-app HMAC creds in SSM. Manager mirrors the local hmacSecret
      // into a SecureString at install (PutParameter) and deletes it at
      // uninstall (DeleteParameter). No GetParameter — Manager never needs
      // to read the secret; only the per-app role and the broker do.
      Sid: "ManagerManageAppCreds",
      Effect: "Allow",
      Action: [
        "ssm:PutParameter",
        "ssm:DeleteParameter",
        "ssm:AddTagsToResource",
        "ssm:RemoveTagsFromResource",
      ],
      Resource: SUB(`arn:aws:ssm:*:*:parameter/${stackPrefix}/app-creds/*`),
    },
    {
      // SecureString PutParameter calls KMS Encrypt under the SSM service
      // key. Scoped by kms:ViaService so Manager can only encrypt
      // SSM-bound ciphertexts.
      Sid: "ManagerAppCredsKmsEncrypt",
      Effect: "Allow",
      Action: ["kms:Encrypt", "kms:GenerateDataKey", "kms:Decrypt"],
      Resource: "*",
      Condition: {
        StringLike: { "kms:ViaService": "ssm.*.amazonaws.com" },
      },
    },
    {
      // Foundational, one-time account setup: submit the Bedrock provider
      // use-case-details form so on-demand invoke of gated models (e.g.
      // Anthropic) is permitted. Account-global (Resource "*"), not per-app and
      // not a data-plane verb — Manager is the install hub that performs it once
      // during the cloud-data-server foundational install (idempotent: Get, then
      // Put only if absent). *UseCaseForModelAccess = Get + Put.
      Sid: "ManagerBedrockUseCaseForm",
      Effect: "Allow",
      Action: "bedrock:*UseCaseForModelAccess",
      Resource: "*",
    },
    // -----------------------------------------------------------------------
    // Bedrock spend guardrail (budget-guardrail plan §4.2).
    //
    // Budget management goes through Manager, not the admin-app role. Manager is
    // already the deployment's hub for account-global foundational setup (it
    // submits the Bedrock use-case form) and holds no data-plane power; budgets
    // verbs are cost governance, not data plane, so this does not widen admin.
    // -----------------------------------------------------------------------
    {
      // Action ARNs are children of the budget ARN, so one resource pattern
      // covers both. Scoped to this deployment's own budgets.
      Sid: "ManagerManageBedrockBudget",
      Effect: "Allow",
      Action: [
        "budgets:ViewBudget",
        "budgets:ModifyBudget",
        "budgets:CreateBudgetAction",
        "budgets:UpdateBudgetAction",
        "budgets:DeleteBudgetAction",
        "budgets:DescribeBudgetAction",
        "budgets:DescribeBudgetActionsForBudget",
        "budgets:DescribeBudgetActionHistories",
        "budgets:ExecuteBudgetAction",
      ],
      Resource: SUB(`arn:aws:budgets::*:budget/${stackPrefix}-*`),
    },
    {
      // Handing the budget-action role to Budgets is the whole point of the
      // action; PassedToService bounds it to exactly that. Manager holds no
      // other PassRole today, so this is the narrowest possible addition.
      Sid: "ManagerPassBedrockBudgetActionRole",
      Effect: "Allow",
      Action: "iam:PassRole",
      Resource: SUB(`arn:aws:iam::*:role/${stackPrefix}-bedrock-budget-action-role`),
      Condition: {
        StringEquals: { "iam:PassedToService": "budgets.amazonaws.com" },
      },
    },
    {
      // Powers the manual Freeze now / Resume controls — and, importantly, makes
      // the whole freeze path deterministically testable without waiting on a
      // real budget breach. Identical scope and condition to the budget-action
      // role's own grant: only the freeze policy, only on the roles that can
      // spend on Bedrock. `iam:PolicyARN` is what keeps this from being a
      // general "attach any policy" escalation.
      Sid: "ManagerAttachDetachBedrockFreezePolicy",
      Effect: "Allow",
      Action: ["iam:AttachRolePolicy", "iam:DetachRolePolicy"],
      Resource: bedrockFreezeTargetRoleNames(stackPrefix).map((roleName) =>
        SUB(`arn:aws:iam::*:role/${roleName}`),
      ),
      Condition: {
        ArnEquals: {
          "iam:PolicyARN": SUB(`arn:aws:iam::*:policy/${stackPrefix}-bedrock-freeze-policy`),
        },
      },
    },
  ];
}
