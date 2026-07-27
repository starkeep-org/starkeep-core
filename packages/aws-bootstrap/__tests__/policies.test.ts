import { describe, it, expect } from "vitest";
import {
  managerPolicyStatements,
  adminAppPolicyStatements,
  appPermissionsBoundaryStatements,
  foundationalPermissionsBoundaryStatements,
  installDdlBoundaryStatements,
  installInfraBoundaryStatements,
  capabilityBrokerPermissionsBoundaryStatements,
} from "../src/bootstrap/index.js";
import { userDataOwnerPermissionsBoundaryStatements } from "../src/bootstrap/user-data-owner-permissions-boundary.js";
import {
  bedrockFreezePolicyStatements,
  BEDROCK_FREEZE_EXEMPT_ACTIONS,
} from "../src/bootstrap/bedrock-freeze-policy.js";
import {
  bedrockFreezePolicyName,
  bedrockBudgetActionRoleName,
} from "../src/bedrock-budget-spec.js";
import { MAX_STACK_PREFIX_LENGTH } from "../src/bootstrap/index.js";
import type { IamStatement, CfnValue } from "../src/iam-utils.js";

const PREFIX = "starkeep";

function actionsOf(statements: IamStatement[], effect: "Allow" | "Deny" = "Allow"): string[] {
  return statements
    .filter((s) => s.Effect === effect)
    .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
}

function byId(statements: IamStatement[], sid: string): IamStatement {
  const found = statements.find((s) => s.Sid === sid);
  if (!found) throw new Error(`No statement with Sid ${sid}`);
  return found;
}

function cfnString(v: CfnValue): string {
  if (typeof v === "string") return v;
  if ("Sub" in v) return v.Sub;
  if ("GetAtt" in v) return v.GetAtt;
  return v.Ref;
}

/** Every boundary must carry the mutating-IAM Deny block. */
function expectDeniesMutatingIam(statements: IamStatement[]): void {
  const deny = statements.find(
    (s) => s.Effect === "Deny" && /DenyOtherIam$/.test(s.Sid),
  );
  expect(deny, "expected a DenyOtherIam statement").toBeDefined();
  const actions = Array.isArray(deny!.Action) ? deny!.Action : [deny!.Action];
  for (const verb of ["iam:Create*", "iam:Put*", "iam:Attach*", "iam:Delete*", "iam:Update*"]) {
    expect(actions).toContain(verb);
  }
  expect(deny!.Resource).toBe("*");
}

describe("manager policy (the install/uninstall allow-list)", () => {
  const statements = managerPolicyStatements(PREFIX);

  it("allows exactly the delegation action set — no data-plane power", () => {
    expect([...new Set(actionsOf(statements))].sort()).toEqual(
      [
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:UpdateRole",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
        "iam:UpdateAssumeRolePolicy",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:GetRolePolicy",
        "sts:AssumeRole",
        "sts:GetCallerIdentity",
        "ssm:PutParameter",
        "ssm:DeleteParameter",
        "ssm:AddTagsToResource",
        "ssm:RemoveTagsFromResource",
        "kms:Encrypt",
        "kms:GenerateDataKey",
        "kms:Decrypt",
        // Foundational one-time account setup: submit the Bedrock use-case form
        // so gated providers can be invoked (plan §3.6). Account config, not a
        // data-plane verb — the negatives below still hold.
        "bedrock:*UseCaseForModelAccess",
        // Bedrock spend guardrail (§4.2): cost governance, not data plane.
        "budgets:ViewBudget",
        "budgets:ModifyBudget",
        "budgets:CreateBudgetAction",
        "budgets:UpdateBudgetAction",
        "budgets:DeleteBudgetAction",
        "budgets:DescribeBudgetAction",
        "budgets:DescribeBudgetActionsForBudget",
        "budgets:DescribeBudgetActionHistories",
        "budgets:ExecuteBudgetAction",
        "iam:PassRole",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
      ].sort(),
    );
    // The load-bearing negatives: Manager can never read user data or app secrets.
    const actions = actionsOf(statements);
    expect(actions).not.toContain("ssm:GetParameter");
    expect(actions.some((a) => a.startsWith("s3:"))).toBe(false);
    expect(actions.some((a) => a.startsWith("dsql:"))).toBe(false);
  });

  it("gates CreateRole on exactly the three known permissions boundaries", () => {
    const create = byId(statements, "ManagerCreateAppRoleWithBoundary");
    expect(create.Action).toBe("iam:CreateRole");
    expect(cfnString(create.Resource as CfnValue)).toBe(
      `arn:aws:iam::*:role/${PREFIX}-app-*`,
    );
    const boundaries = (
      create.Condition!.ArnLike["iam:PermissionsBoundary"] as CfnValue[]
    ).map(cfnString);
    expect(boundaries).toEqual([
      `arn:aws:iam::*:policy/${PREFIX}-app-permissions-boundary`,
      `arn:aws:iam::*:policy/${PREFIX}-foundational-permissions-boundary`,
      `arn:aws:iam::*:policy/${PREFIX}-user-data-owner-permissions-boundary`,
      `arn:aws:iam::*:policy/${PREFIX}-capability-broker-permissions-boundary`,
    ]);
  });

  it("scopes role management to ${prefix}-app-*, the two install roles, and the budget-action role", () => {
    const roleResources = statements
      .filter((s) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        return actions.some((a) => a.startsWith("iam:")) && s.Effect === "Allow";
      })
      .flatMap((s) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]))
      .map(cfnString);
    for (const r of roleResources) {
      expect(r).toMatch(
        new RegExp(
          `^arn:aws:iam::\\*:role/${PREFIX}-(app-\\*|app-capability-broker-role|install-ddl-role|install-infra-role|bedrock-budget-action-role)$`,
        ),
      );
    }
  });

  // The Bedrock spend guardrail's Manager grants (§4.2). Each one is an
  // escalation verb whose safety rests entirely on its condition, so the
  // conditions are asserted positively AND the absence of an unconditioned
  // second statement is asserted — a presence-only test would pass on a
  // dangerously wide policy.
  it("scopes the budgets verbs to this deployment's own budgets", () => {
    const budgets = byId(statements, "ManagerManageBedrockBudget");
    expect(cfnString(budgets.Resource as CfnValue)).toBe(
      `arn:aws:budgets::*:budget/${PREFIX}-*`,
    );
    const actions = Array.isArray(budgets.Action) ? budgets.Action : [budgets.Action];
    expect(actions.every((a) => a.startsWith("budgets:"))).toBe(true);
  });

  it("PassRole carries iam:PassedToService and exists nowhere unconditioned", () => {
    const passRoleStatements = statements.filter((s) =>
      (Array.isArray(s.Action) ? s.Action : [s.Action]).includes("iam:PassRole"),
    );
    expect(passRoleStatements).toHaveLength(1);
    const [pass] = passRoleStatements;
    expect(cfnString(pass.Resource as CfnValue)).toBe(
      `arn:aws:iam::*:role/${PREFIX}-bedrock-budget-action-role`,
    );
    expect(pass.Condition).toEqual({
      StringEquals: { "iam:PassedToService": "budgets.amazonaws.com" },
    });
  });

  it("attach/detach carries iam:PolicyARN and exists nowhere unconditioned", () => {
    const attachStatements = statements.filter((s) =>
      (Array.isArray(s.Action) ? s.Action : [s.Action]).some(
        (a) => a === "iam:AttachRolePolicy" || a === "iam:DetachRolePolicy",
      ),
    );
    expect(attachStatements).toHaveLength(1);
    const [attach] = attachStatements;
    expect(attach.Action).toEqual(["iam:AttachRolePolicy", "iam:DetachRolePolicy"]);
    expect((attach.Resource as CfnValue[]).map(cfnString)).toEqual([
      `arn:aws:iam::*:role/${PREFIX}-app-capability-broker-role`,
    ]);
    expect(
      cfnString(attach.Condition!.ArnEquals["iam:PolicyARN"] as CfnValue),
    ).toBe(`arn:aws:iam::*:policy/${PREFIX}-bedrock-freeze-policy`);
  });

  it("manages app-creds SSM parameters but can never read them back", () => {
    const creds = byId(statements, "ManagerManageAppCreds");
    expect(cfnString(creds.Resource as CfnValue)).toBe(
      `arn:aws:ssm:*:*:parameter/${PREFIX}/app-creds/*`,
    );
    expect(creds.Action).not.toContain("ssm:GetParameter");
  });

  it("KMS access is confined to SSM-bound ciphertexts via ViaService", () => {
    const kms = byId(statements, "ManagerAppCredsKmsEncrypt");
    expect(kms.Condition).toEqual({
      StringLike: { "kms:ViaService": "ssm.*.amazonaws.com" },
    });
  });
});

describe("per-app permissions boundary (the per-app runtime ceiling)", () => {
  const statements = appPermissionsBoundaryStatements(PREFIX);

  it("confines per-object S3 to the app's own principal-tagged prefix", () => {
    const own = byId(statements, "AppS3OwnPrefix");
    expect(own.Resource).toBe(
      `arn:aws:s3:::${PREFIX}-files-*/apps/\${aws:PrincipalTag/starkeep:appId}/*`,
    );
  });

  it("scopes ListBucket by s3:prefix to own + shared prefixes (no cross-app listing)", () => {
    const list = byId(statements, "AppS3ListOwnAndShared");
    expect(list.Condition!.StringLike["s3:prefix"]).toEqual([
      `apps/\${aws:PrincipalTag/starkeep:appId}/*`,
      "shared/*",
    ]);
  });

  it("permits dsql:DbConnect but never DbConnectAdmin", () => {
    expect(actionsOf(statements)).toContain("dsql:DbConnect");
    expect(actionsOf(statements)).not.toContain("dsql:DbConnectAdmin");
  });

  it("grants no install-time provisioning power (Lambda/APIGW/Pulumi admin)", () => {
    const actions = actionsOf(statements);
    expect(actions.some((a) => a.startsWith("lambda:") && a !== "lambda:InvokeFunction")).toBe(
      false,
    );
    expect(actions.some((a) => a.startsWith("apigateway"))).toBe(false);
    expect(actions.some((a) => a.startsWith("iam:"))).toBe(false);
  });

  it("denies mutating IAM", () => expectDeniesMutatingIam(statements));
});

describe("user-data-owner boundary (Drive's layer-2 hard floor)", () => {
  const statements = userDataOwnerPermissionsBoundaryStatements(PREFIX);

  it("caps shared-data custody at the shared/* prefix", () => {
    const shared = byId(statements, "UserDataOwnerS3SharedData");
    expect(shared.Resource).toBe(`arn:aws:s3:::${PREFIX}-files-*/shared/*`);
    expect(shared.Action).toEqual(["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]);
  });

  it("is narrower than foundational: no Lambda, no API Gateway, no DSQL admin", () => {
    const actions = actionsOf(statements);
    expect(actions.some((a) => a.startsWith("lambda:"))).toBe(false);
    expect(actions.some((a) => a.startsWith("apigateway"))).toBe(false);
    expect(actions).not.toContain("dsql:DbConnectAdmin");
    expect(actions).toContain("dsql:DbConnect");
  });

  it("denies mutating IAM", () => expectDeniesMutatingIam(statements));
});

describe("capability-broker boundary (Bedrock invoke + S3-location I/O ceiling)", () => {
  const statements = capabilityBrokerPermissionsBoundaryStatements(PREFIX);

  it("permits all-Bedrock invoke incl. async generation (all-or-nothing, plan §3.3/§3.8)", () => {
    const invoke = byId(statements, "CapabilityBedrockInvoke");
    expect(invoke.Action).toContain("bedrock:InvokeModel");
    expect(invoke.Action).toContain("bedrock:Converse");
    expect(invoke.Action).toContain("bedrock:ConverseStream");
    // Async generation verbs (§3.8) + the async-invoke resource ARN.
    expect(invoke.Action).toContain("bedrock:StartAsyncInvoke");
    expect(invoke.Action).toContain("bedrock:GetAsyncInvoke");
    const resources = Array.isArray(invoke.Resource) ? invoke.Resource : [invoke.Resource];
    const rstrs = resources.map((r) => cfnString(r as CfnValue));
    expect(rstrs).toContain("arn:aws:bedrock:*::foundation-model/*");
    expect(rstrs).toContain("arn:aws:bedrock:*:*:async-invoke/*");
  });

  it("scopes S3-location I/O (read + async-output write) to the files bucket, never *", () => {
    const s3 = byId(statements, "CapabilitySessionScopedS3IO");
    // GetObject (input, §3.4) + PutObject (async output, §3.8), nothing else.
    expect(s3.Action).toEqual(["s3:GetObject", "s3:PutObject"]);
    expect(cfnString(s3.Resource as CfnValue)).toBe(`arn:aws:s3:::${PREFIX}-files-*/*`);
    // The blast radius (TC2) must not reach billing/pulumi-state/artifacts or *.
    const s3Resources = statements
      .filter((st) => st.Effect === "Allow")
      .flatMap((st) => (Array.isArray(st.Resource) ? st.Resource : [st.Resource]))
      .map((r) => cfnString(r as CfnValue))
      .filter((r) => r.startsWith("arn:aws:s3"));
    expect(s3Resources).toEqual([`arn:aws:s3:::${PREFIX}-files-*/*`]);
  });

  it("grants no other service power (no data DB, no other AWS services; no S3 delete)", () => {
    const actions = actionsOf(statements);
    expect(actions.every((a) => a.startsWith("bedrock:") || a.startsWith("s3:"))).toBe(true);
    // S3 is confined to Get/Put on the files bucket — never Delete/List/etc.
    expect(actions.filter((a) => a.startsWith("s3:")).sort()).toEqual(["s3:GetObject", "s3:PutObject"]);
    expect(actions.some((a) => a.startsWith("s3:Delete"))).toBe(false);
  });

  it("denies mutating IAM", () => expectDeniesMutatingIam(statements));
});

describe("install-ddl boundary", () => {
  const statements = installDdlBoundaryStatements(PREFIX);

  it("allows exactly dsql:DbConnectAdmin and nothing else", () => {
    expect(actionsOf(statements)).toEqual(["dsql:DbConnectAdmin"]);
  });

  it("denies mutating IAM", () => expectDeniesMutatingIam(statements));
});

describe("install-infra boundary", () => {
  const statements = installInfraBoundaryStatements(PREFIX);

  it("permits provisioning surfaces but no data plane (files bucket untouchable)", () => {
    const resources = statements
      .filter((s) => s.Effect === "Allow")
      .flatMap((s) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]))
      .map((r) => cfnString(r as CfnValue));
    expect(resources.some((r) => r.includes(`${PREFIX}-files-`))).toBe(false);
    const actions = actionsOf(statements);
    expect(actions.some((a) => a.startsWith("dsql:"))).toBe(false);
  });

  it("PassRole is restricted to per-app roles handed to Lambda", () => {
    const pass = byId(statements, "InstallInfraPassRoleAppToLambda");
    expect(pass.Action).toBe("iam:PassRole");
    expect(cfnString(pass.Resource as CfnValue)).toBe(`arn:aws:iam::*:role/${PREFIX}-app-*`);
  });

  it("denies mutating IAM", () => expectDeniesMutatingIam(statements));
});

describe("foundational boundary (cloud-data-server only)", () => {
  const statements = foundationalPermissionsBoundaryStatements(PREFIX);

  it("may assume per-app roles (broker power) — unique among boundaries", () => {
    const assume = byId(statements, "FoundationalBrokerAssumeAppRoles");
    expect(assume.Action).toBe("sts:AssumeRole");
    expect(cfnString(assume.Resource as CfnValue)).toContain(`role/${PREFIX}-app-`);
  });

  it("denies mutating IAM (service-linked-role creation aside)", () => {
    const deny = byId(statements, "FoundationalDenyOtherIam");
    expect(deny.Effect).toBe("Deny");
  });
});

describe("admin-app policy", () => {
  const statements = adminAppPolicyStatements(PREFIX);

  it("can assume Manager but holds no IAM mutation power of its own", () => {
    const assume = byId(statements, "AdminAppAssumeManager");
    expect(assume.Action).toBe("sts:AssumeRole");
    const actions = actionsOf(statements);
    expect(actions.some((a) => a.startsWith("iam:"))).toBe(false);
  });
});

describe("Bedrock freeze policy (the structural spend backstop)", () => {
  const statements = bedrockFreezePolicyStatements();

  /**
   * Does an IAM action pattern (`bedrock:Invoke*`) match a concrete action name?
   * The whole point of the wildcard patterns is what they do and don't catch, so
   * the invariants below are asserted by MATCHING rather than by eyeballing the
   * pattern list — a pattern rewrite is exactly the edit that would silently
   * break them.
   */
  function matches(pattern: string, action: string): boolean {
    const rx = new RegExp(
      `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`,
      "i",
    );
    return rx.test(action);
  }
  const patterns = statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
  const denies = (action: string) => patterns.some((p) => matches(p, action));

  it("is a single Deny on all resources", () => {
    expect(statements).toHaveLength(1);
    expect(statements[0].Effect).toBe("Deny");
    expect(statements[0].Resource).toBe("*");
    expect(patterns).toEqual([
      "bedrock:Invoke*",
      "bedrock:Converse*",
      "bedrock:StartAsync*",
      "bedrock:Retrieve*",
      "bedrock:Rerank*",
    ]);
  });

  it("denies every Bedrock spend verb the broker uses today", () => {
    for (const action of [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
      "bedrock:Converse",
      "bedrock:ConverseStream",
      "bedrock:StartAsyncInvoke",
    ]) {
      expect(denies(action), `${action} must be denied`).toBe(true);
    }
  });

  it("denies plausible FUTURE spend verbs without a policy edit", () => {
    // The automation claim of §9 Q5, tested rather than asserted in prose.
    for (const action of [
      "bedrock:InvokeAgent",
      "bedrock:InvokeFlow",
      "bedrock:ConverseStream",
      "bedrock:RetrieveAndGenerate",
      "bedrock:Rerank",
    ]) {
      expect(denies(action), `${action} should be caught by the wildcards`).toBe(true);
    }
  });

  it("NEVER denies the async-invoke poll", () => {
    // §4.1's accounting invariant: a submitted video job bills whether or not we
    // freeze, so denying the poll would strand the ledger with an unreconciled
    // reservation and the app with a job it can never collect. `StartAsync*` is
    // chosen over `*Async*` precisely to keep these two allowed.
    for (const action of BEDROCK_FREEZE_EXEMPT_ACTIONS) {
      expect(denies(action), `${action} must stay allowed through a freeze`).toBe(false);
    }
  });
});

describe("resource name lengths (IAM's 64-char ceiling)", () => {
  const MAX_PREFIX = "x".repeat(MAX_STACK_PREFIX_LENGTH);
  const IAM_NAME_LIMIT = 64;

  it.each([
    ["bedrock-freeze-policy", bedrockFreezePolicyName],
    ["bedrock-budget-action-role", bedrockBudgetActionRoleName],
  ])("%s fits at the longest allowed prefix", (_label, build) => {
    expect(build(MAX_PREFIX).length).toBeLessThanOrEqual(IAM_NAME_LIMIT);
  });
});

describe("managed-policy size (AWS 6144-char ceiling)", () => {
  // Each permissions boundary is deployed as an AWS::IAM::ManagedPolicy, whose
  // document may not exceed 6144 characters — whitespace excluded — or
  // CreateStack fails with `Cannot exceed quota for PolicySize: 6144`. The
  // StackPrefix is interpolated into these documents at generation time, so the
  // worst case is the longest prefix the template permits
  // (MAX_STACK_PREFIX_LENGTH). Guarding at that length means no permitted
  // deploy can overflow, regardless of the prefix the operator picks.
  const MANAGED_POLICY_SIZE_LIMIT = 6144;
  const MAX_PREFIX = "x".repeat(MAX_STACK_PREFIX_LENGTH);

  // Resolve any CFN intrinsic to the string it deploys to, so the size matches
  // the policy document CloudFormation actually submits. The boundaries use
  // plain interpolated strings today; the Sub/Ref arms are defensive.
  function resolveCfn(v: unknown): unknown {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(resolveCfn);
    const o = v as Record<string, unknown>;
    if ("Sub" in o) return (o.Sub as string).replace(/\$\{[^}]+\}/g, "123456789012");
    if ("GetAtt" in o) return "arn:aws:iam::123456789012:role/placeholder";
    if ("Ref" in o) return "arn:aws:iam::123456789012:policy/placeholder";
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) out[k] = resolveCfn(val);
    return out;
  }

  // AWS counts the policy document with whitespace stripped.
  function policyDocSize(statements: IamStatement[]): number {
    const doc = { Version: "2012-10-17", Statement: resolveCfn(statements) };
    return JSON.stringify(doc).replace(/\s/g, "").length;
  }

  // Every managed policy in the bootstrap template = the six boundaries plus
  // the Bedrock freeze policy.
  const managedPolicies: Record<string, (p: string) => IamStatement[]> = {
    "bedrock-freeze-policy": () => bedrockFreezePolicyStatements(),
    "app-permissions-boundary": appPermissionsBoundaryStatements,
    "foundational-permissions-boundary": foundationalPermissionsBoundaryStatements,
    "user-data-owner-permissions-boundary": userDataOwnerPermissionsBoundaryStatements,
    "install-ddl-permissions-boundary": installDdlBoundaryStatements,
    "install-infra-permissions-boundary": installInfraBoundaryStatements,
    "capability-broker-permissions-boundary": capabilityBrokerPermissionsBoundaryStatements,
  };

  for (const [name, build] of Object.entries(managedPolicies)) {
    it(`${name} fits under 6144 at the longest allowed prefix`, () => {
      const size = policyDocSize(build(MAX_PREFIX));
      expect(
        size,
        `${name} is ${size} chars at a ${MAX_STACK_PREFIX_LENGTH}-char prefix ` +
          `(limit ${MANAGED_POLICY_SIZE_LIMIT}). Trim the boundary or lower ` +
          `MAX_STACK_PREFIX_LENGTH.`,
      ).toBeLessThanOrEqual(MANAGED_POLICY_SIZE_LIMIT);
    });
  }
});
