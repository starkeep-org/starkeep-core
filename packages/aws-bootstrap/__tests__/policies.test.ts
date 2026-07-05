import { describe, it, expect } from "vitest";
import {
  managerPolicyStatements,
  adminAppPolicyStatements,
  appPermissionsBoundaryStatements,
  foundationalPermissionsBoundaryStatements,
  installDdlBoundaryStatements,
  installInfraBoundaryStatements,
} from "../src/bootstrap/index.js";
import { userDataOwnerPermissionsBoundaryStatements } from "../src/bootstrap/user-data-owner-permissions-boundary.js";
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
    ]);
  });

  it("scopes role management to ${prefix}-app-* and the two install roles only", () => {
    const roleResources = statements
      .filter((s) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        return actions.some((a) => a.startsWith("iam:")) && s.Effect === "Allow";
      })
      .map((s) => cfnString(s.Resource as CfnValue));
    for (const r of roleResources) {
      expect(r).toMatch(
        new RegExp(`^arn:aws:iam::\\*:role/${PREFIX}-(app-\\*|install-ddl-role|install-infra-role)$`),
      );
    }
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

  // Every managed policy in the bootstrap template = the five boundaries.
  const managedPolicies: Record<string, (p: string) => IamStatement[]> = {
    "app-permissions-boundary": appPermissionsBoundaryStatements,
    "foundational-permissions-boundary": foundationalPermissionsBoundaryStatements,
    "user-data-owner-permissions-boundary": userDataOwnerPermissionsBoundaryStatements,
    "install-ddl-permissions-boundary": installDdlBoundaryStatements,
    "install-infra-permissions-boundary": installInfraBoundaryStatements,
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
