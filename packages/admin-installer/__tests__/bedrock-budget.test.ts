/**
 * Step 1d of the cloud-data-server install — the Bedrock spend guardrail
 * (budget-guardrail plan §4.4/§4.5, tests per §8.1).
 *
 * Two things are under test and neither is the AWS call itself (those live in
 * `@starkeep/aws-bootstrap`'s `bedrock-budget-ops.test.ts`):
 *
 *   1. The PREFERENCE resolution, whose default decides whether every existing
 *      deployment gets a guardrail on its next install. A regression here fails
 *      silently and open.
 *   2. The WIRING — that step 1d runs after the role its action targets exists,
 *      and that a failure at this step warns without taking the install down
 *      with it. "No guardrail" must never mean "no install".
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const ensureBedrockBudgetMock = vi.fn(async () => ({
  createdBudget: true,
  updatedLimit: false,
  createdAction: true,
  updatedAction: false,
}));
const deleteBedrockBudgetMock = vi.fn(async () => {});

vi.mock("@starkeep/aws-bootstrap/bedrock-budget-ops", () => ({
  ensureBedrockBudget: (...args: unknown[]) => {
    calls.push("1d:budget");
    return ensureBedrockBudgetMock(...(args as []));
  },
  deleteBedrockBudget: (...args: unknown[]) => {
    calls.push("teardown:budget");
    return deleteBedrockBudgetMock(...(args as []));
  },
  describeBedrockBudget: vi.fn(),
  freezeBedrock: vi.fn(),
  resumeBedrock: vi.fn(),
}));

/** Ordered log of the install steps that matter for step 1d's placement. */
const calls: string[] = [];

vi.mock("../src/session", () => ({
  roleChain: vi.fn(async () => ({
    accessKeyId: "AK",
    secretAccessKey: "SK",
    sessionToken: "ST",
  })),
}));

vi.mock("../src/iam", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/iam")>();
  return {
    ...real,
    appRoleExists: vi.fn(async () => true),
    updateAppRoleTrustPolicy: vi.fn(async () => {}),
    createAppRole: vi.fn(async () => "arn:fake"),
    createCapabilityBrokerRole: vi.fn(async () => {
      calls.push("1b:capability-broker-role");
    }),
    deleteCapabilityBrokerRole: vi.fn(async () => {
      calls.push("teardown:capability-broker-role");
    }),
    deleteAppRoleWithPolicies: vi.fn(async () => {}),
    // false ⇒ the install skips its 60s IAM-propagation sleep.
    attachTempInstallCloudDataServerPolicy: vi.fn(async () => false),
    detachTempInstallCloudDataServerPolicy: vi.fn(async () => {}),
  };
});

vi.mock("../src/bedrock-usecase", () => ({
  ensureBedrockUseCaseForm: vi.fn(async () => {
    calls.push("1c:use-case-form");
    return "already-present" as const;
  }),
}));

const pulumiOutputs = {
  auroraHostname: "fake.dsql",
  bucketName: "starkeep-files-x",
  apiGatewayId: "api123",
  apiGatewayExecutionArn: "arn:execute-api",
  apiGatewayUrl: "https://api.example.com",
  publicBaseUrl: "https://cdn.example.com",
  authorizerId: "auth123",
  functionArn: "arn:fn",
  capabilityStreamFunction: "starkeep-app-cloud-data-server-capability-stream",
  region: "us-east-1",
  cloudfrontKeyPairId: "K123",
  cloudfrontSigningDomain: "cdn.example.com",
  cloudfrontSigningPrivateKey: "-----BEGIN PRIVATE KEY-----",
};

vi.mock("../src/compute-stack", () => ({
  pulumiUpInline: vi.fn(async () => {
    calls.push("4:pulumi-up");
    return pulumiOutputs;
  }),
  pulumiDestroyInline: vi.fn(async () => {}),
}));

const initializeSharedSchemaMock = vi.fn(async () => {});
vi.mock("../src/dsql-schema-init", () => ({
  initializeSharedSchema: (...args: unknown[]) => initializeSharedSchemaMock(...(args as [])),
  installerPgUser: (p: string) => `${p}_installer`,
}));

vi.mock("../src/app-creds", () => ({
  putCloudFrontSigningParameter: vi.fn(async () => {}),
}));

vi.mock("../src/iam-diagnostics", () => ({
  logAppRoleSnapshot: vi.fn(async () => {}),
  logCallerIdentity: vi.fn(async () => {}),
}));

vi.mock("../src/orchestrator", () => ({
  installApp: vi.fn(async () => {}),
  uninstallApp: vi.fn(async () => {}),
}));

// The bundle hash is read off disk at pulumi time; the real dist.zip may not be
// built when this unit test runs, and its contents are irrelevant here.
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    readFileSync: (path: Parameters<typeof real.readFileSync>[0], ...rest: unknown[]) => {
      if (typeof path === "string" && path.endsWith("dist.zip")) return Buffer.from("zip");
      return real.readFileSync(path, ...(rest as []));
    },
  };
});

import {
  installCloudDataServer,
  uninstallCloudDataServer,
  type CloudDataServerInstallConfig,
} from "../src/builtin-installs";
import {
  resolveBedrockBudgetPreference,
  ensureBedrockBudgetStep,
  defaultBedrockCostGateUsd,
  DEFAULT_BEDROCK_BUDGET_LIMIT_USD,
} from "../src/bedrock-budget";

const managerCreds = { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" };

function installConfig(
  overrides: Partial<CloudDataServerInstallConfig> = {},
): CloudDataServerInstallConfig {
  return {
    stackPrefix: "starkeep",
    region: "us-east-1",
    accountId: "111122223333",
    permissionsBoundaryArn: "arn:boundary",
    foundationalPermissionsBoundaryArn: "arn:boundary-foundational",
    userDataOwnerPermissionsBoundaryArn: "arn:boundary-udo",
    capabilityBrokerPermissionsBoundaryArn: "arn:boundary-capability-broker",
    managerRoleArn: "arn:manager",
    pulumiStateBucket: "starkeep-pulumi-state-x",
    userPoolId: "us-east-1_abc",
    userPoolClientId: "client",
    operatorEmail: "operator@example.com",
    ...overrides,
  };
}

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
  ensureBedrockBudgetMock.mockResolvedValue({
    createdBudget: true,
    updatedLimit: false,
    createdAction: true,
    updatedAction: false,
  });
  deleteBedrockBudgetMock.mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("resolveBedrockBudgetPreference", () => {
  it("treats an ABSENT block as enabled at $25", () => {
    // The whole reason existing deployments gain a guardrail on their next
    // install. A regression here silently disables it for every one of them.
    expect(resolveBedrockBudgetPreference(undefined, "op@example.com")).toEqual({
      enabled: true,
      limitUsd: DEFAULT_BEDROCK_BUDGET_LIMIT_USD,
      limitMicros: 25_000_000,
      notifyEmail: "op@example.com",
    });
  });

  it("honours an explicit opt-out", () => {
    expect(resolveBedrockBudgetPreference({ enabled: false }).enabled).toBe(false);
  });

  it("keeps an operator's limit and converts it to micros", () => {
    const pref = resolveBedrockBudgetPreference({ limitUsd: 12.5 });
    expect(pref.limitUsd).toBe(12.5);
    expect(pref.limitMicros).toBe(12_500_000);
  });

  it("falls back to the default on a nonsense limit rather than to zero", () => {
    // A $0 budget freezes Bedrock the moment anything is spent; a NaN one is
    // unrepresentable. Neither is what the operator meant, so neither is honoured.
    for (const limitUsd of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveBedrockBudgetPreference({ limitUsd }).limitUsd).toBe(
        DEFAULT_BEDROCK_BUDGET_LIMIT_USD,
      );
    }
  });

  it("prefers an explicit notifyEmail over the operator's sign-in address", () => {
    expect(
      resolveBedrockBudgetPreference({ notifyEmail: "alerts@example.com" }, "op@example.com")
        .notifyEmail,
    ).toBe("alerts@example.com");
  });
});

describe("defaultBedrockCostGateUsd", () => {
  it("is 80% of the budget, so the soft ceiling trips first", () => {
    expect(defaultBedrockCostGateUsd(25)).toBe(20);
    expect(defaultBedrockCostGateUsd(100)).toBe(80);
  });
});

describe("ensureBedrockBudgetStep", () => {
  it("skips every AWS call when disabled", async () => {
    const outcome = await ensureBedrockBudgetStep({
      stackPrefix: "starkeep",
      accountId: "111122223333",
      managerCreds,
      preference: { enabled: false },
      operatorEmail: "op@example.com",
    });
    expect(outcome).toEqual({ status: "disabled" });
    expect(ensureBedrockBudgetMock).not.toHaveBeenCalled();
  });

  it("skips (without failing) when there is no address to subscribe", async () => {
    // Budgets rejects an action with no subscriber, so there is nothing to
    // create — but this is a "tell the operator", not a "fail the install".
    const outcome = await ensureBedrockBudgetStep({
      stackPrefix: "starkeep",
      accountId: "111122223333",
      managerCreds,
      preference: {},
    });
    expect(outcome.status).toBe("skipped");
    expect(ensureBedrockBudgetMock).not.toHaveBeenCalled();
  });

  it("returns failed — never throws — when AWS rejects the call", async () => {
    ensureBedrockBudgetMock.mockRejectedValueOnce(
      Object.assign(new Error("policy not found"), { name: "NoSuchEntityException" }),
    );
    const outcome = await ensureBedrockBudgetStep({
      stackPrefix: "starkeep",
      accountId: "111122223333",
      managerCreds,
      preference: undefined,
      operatorEmail: "op@example.com",
    });
    expect(outcome).toEqual({ status: "failed", reason: "policy not found" });
  });
});

describe("install wiring (step 1d)", () => {
  it("runs after the capability-broker role is minted and after the use-case form", async () => {
    // Ordering is a real constraint, not a preference: the budget action's
    // Roles[] names the broker role, so creating the action before step 1b would
    // reference a role that does not exist.
    await installCloudDataServer(installConfig());
    expect(calls.indexOf("1d:budget")).toBeGreaterThan(calls.indexOf("1b:capability-broker-role"));
    expect(calls.indexOf("1d:budget")).toBeGreaterThan(calls.indexOf("1c:use-case-form"));
    expect(calls.indexOf("1d:budget")).toBeLessThan(calls.indexOf("4:pulumi-up"));
  });

  it("creates the guardrail at the $25 default when config.json says nothing", async () => {
    await installCloudDataServer(installConfig());
    expect(ensureBedrockBudgetMock).toHaveBeenCalledTimes(1);
    expect(ensureBedrockBudgetMock.mock.calls[0][0]).toMatchObject({
      stackPrefix: "starkeep",
      accountId: "111122223333",
      limitMicros: 25_000_000,
      notifyEmail: "operator@example.com",
    });
  });

  it("makes no Budgets call when the operator disabled it", async () => {
    await installCloudDataServer(installConfig({ bedrockBudget: { enabled: false } }));
    expect(ensureBedrockBudgetMock).not.toHaveBeenCalled();
  });

  it("seeds the soft gate at 80% of the budget's limit", async () => {
    await installCloudDataServer(installConfig({ bedrockBudget: { limitUsd: 100 } }));
    expect(initializeSharedSchemaMock.mock.calls[0][0]).toMatchObject({
      defaultBedrockCostGateUsd: 80,
    });
  });

  it("CONTINUES the install when the freeze policy is missing (old bootstrap stack)", async () => {
    ensureBedrockBudgetMock.mockRejectedValueOnce(
      Object.assign(new Error("policy not found"), { name: "NoSuchEntityException" }),
    );
    // Asserted on the install's OUTCOME, not on a log line: a guardrail the
    // operator hasn't enabled yet must not brick every install until they do.
    const outputs = await installCloudDataServer(installConfig());
    expect(outputs.apiGatewayUrl).toBe("https://api.example.com");
    expect(calls).toContain("4:pulumi-up");
  });

  it("CONTINUES the install on any other Budgets failure", async () => {
    ensureBedrockBudgetMock.mockRejectedValueOnce(new Error("throttled"));
    await expect(installCloudDataServer(installConfig())).resolves.toMatchObject({
      apiGatewayUrl: "https://api.example.com",
    });
  });
});

describe("teardown wiring", () => {
  it("deletes the budget, before the role its action targets", async () => {
    await uninstallCloudDataServer(installConfig());
    expect(deleteBedrockBudgetMock).toHaveBeenCalledTimes(1);
    expect(deleteBedrockBudgetMock.mock.calls[0][0]).toMatchObject({
      stackPrefix: "starkeep",
      accountId: "111122223333",
    });
    expect(calls.indexOf("teardown:budget")).toBeLessThan(
      calls.indexOf("teardown:capability-broker-role"),
    );
  });

  it("finishes the teardown even when the budget delete fails", async () => {
    deleteBedrockBudgetMock.mockRejectedValueOnce(new Error("throttled"));
    await expect(uninstallCloudDataServer(installConfig())).resolves.toBeUndefined();
    expect(calls).toContain("teardown:capability-broker-role");
  });
});
