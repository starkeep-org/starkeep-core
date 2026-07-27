/**
 * The Bedrock spend-guardrail API routes (budget-guardrail plan §4.7).
 *
 * Two contracts are load-bearing at this layer:
 *
 *   - the status route must distinguish "the operator turned it off" from "an
 *     install failed to create it". They render identically to a naive client
 *     and mean opposite things.
 *   - every edit action must actually perform the AWS mutation, and only THEN
 *     write the local preference. config.json records what a future install
 *     should do; AWS is the truth. A preference persisted for a mutation that
 *     failed is a lie the next install acts on.
 *
 * The AWS operations and the DSQL pool are module-mocked; the routes' real
 * validation and the Manager-assume plumbing run unchanged.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextRequest } from "next/server";

const ops = {
  describe: vi.fn(),
  ensure: vi.fn(),
  delete: vi.fn(),
  freeze: vi.fn(),
  resume: vi.fn(),
};

vi.mock("@starkeep/aws-bootstrap/bedrock-budget-ops", () => ({
  describeBedrockBudget: (...a: unknown[]) => ops.describe(...a),
  ensureBedrockBudget: (...a: unknown[]) => ops.ensure(...a),
  deleteBedrockBudget: (...a: unknown[]) => ops.delete(...a),
  freezeBedrock: (...a: unknown[]) => ops.freeze(...a),
  resumeBedrock: (...a: unknown[]) => ops.resume(...a),
}));

const stsState = { assumeError: null as Error | null };

vi.mock("@aws-sdk/client-sts", () => {
  class AssumeRoleCommand {
    constructor(public input: unknown) {}
  }
  class GetCallerIdentityCommand {
    constructor(public input: unknown) {}
  }
  class STSClient {
    async send(cmd: unknown) {
      if (cmd instanceof GetCallerIdentityCommand) return { Account: "111122223333" };
      if (stsState.assumeError) throw stsState.assumeError;
      return {
        Credentials: {
          AccessKeyId: "MANAGER_AK",
          SecretAccessKey: "MANAGER_SK",
          SessionToken: "MANAGER_ST",
        },
      };
    }
  }
  return { STSClient, AssumeRoleCommand, GetCallerIdentityCommand };
});

const pgState = {
  rows: [] as Record<string, unknown>[],
  queryError: null as Error | null,
};

vi.mock("pg", () => {
  class FakePool {
    async query() {
      if (pgState.queryError) throw pgState.queryError;
      return { rows: pgState.rows, rowCount: pgState.rows.length };
    }
    async end() {}
  }
  return { default: { Pool: FakePool }, Pool: FakePool };
});

vi.mock("@aws-sdk/dsql-signer", () => ({
  DsqlSigner: class {
    async getDbConnectAuthToken() {
      return "fake-token";
    }
  },
}));

const CREDS = { accessKeyId: "AKIA", secretAccessKey: "secret", sessionToken: "token" };

let dataDir: string;
let statusPOST: (req: NextRequest) => Promise<Response>;
let editPOST: (req: NextRequest) => Promise<Response>;

function jsonReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

const BASE_CONFIG = {
  stackPrefix: "teststack",
  accountId: "111122223333",
  userPoolId: "us-east-1_abc123",
  auroraEndpoint: "fake.dsql.us-east-1.on.aws",
  operatorEmail: "operator@example.com",
};

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dataDir, "config.json"), "utf-8")) as Record<string, unknown>;
}

function liveStatus(over: Record<string, unknown> = {}) {
  return {
    exists: true,
    limitMicros: 25_000_000,
    actualSpendMicros: 3_500_000,
    forecastedSpendMicros: 9_250_000,
    actionId: "action-1",
    actionStatus: "STANDBY",
    frozenRoleNames: [],
    targetRoleNames: ["teststack-app-capability-broker-role"],
    lastExecuted: null,
    ...over,
  };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "adminweb-bedrock-budget-"));
  process.env.STARKEEP_DIR = dataDir;
  writeConfig(BASE_CONFIG);
  ({ POST: statusPOST } = await import("../app/api/capabilities/bedrock-budget/route"));
  ({ POST: editPOST } = await import("../app/api/capabilities/bedrock-budget/edit/route"));
});

beforeEach(() => {
  vi.clearAllMocks();
  stsState.assumeError = null;
  pgState.rows = [{ limit_value: "20000000" }];
  pgState.queryError = null;
  writeConfig(BASE_CONFIG);
  ops.describe.mockResolvedValue(liveStatus());
  ops.ensure.mockResolvedValue({
    createdBudget: false,
    updatedLimit: true,
    createdAction: false,
    updatedAction: false,
  });
  ops.delete.mockResolvedValue(undefined);
  ops.freeze.mockResolvedValue(["teststack-app-capability-broker-role"]);
  ops.resume.mockResolvedValue({ via: "reverse", roleNames: [] });
});

describe("GET-equivalent status route", () => {
  it("merges live AWS status with the persisted preference", async () => {
    const res = await statusPOST(jsonReq(CREDS));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      exists: true,
      limitMicros: 25_000_000,
      actualSpendMicros: 3_500_000,
      preferenceEnabled: true,
      preferenceLimitUsd: 25,
      frozen: false,
    });
  });

  it("reads the budget under MANAGER credentials, not the admin session's", async () => {
    // Budget management goes through Manager on purpose — it keeps admin from
    // becoming a superuser. A regression that skipped the assume would still
    // work in an account where admin happened to have the verbs.
    await statusPOST(jsonReq(CREDS));
    expect(ops.describe.mock.calls[0][0]).toMatchObject({
      stackPrefix: "teststack",
      accountId: "111122223333",
      credentials: {
        accessKeyId: "MANAGER_AK",
        secretAccessKey: "MANAGER_SK",
        sessionToken: "MANAGER_ST",
      },
    });
  });

  it("reports exists:false with enabled:true distinctly from a disabled guardrail", async () => {
    // An operator who turned it off and an install that failed to create it must
    // not read identically — one is a choice, the other is a broken guardrail.
    ops.describe.mockResolvedValue(liveStatus({ exists: false, limitMicros: null }));
    const failedInstall = (await (await statusPOST(jsonReq(CREDS))).json()) as Record<string, unknown>;
    expect(failedInstall).toMatchObject({ exists: false, preferenceEnabled: true });

    writeConfig({ ...BASE_CONFIG, bedrockBudget: { enabled: false } });
    const disabled = (await (await statusPOST(jsonReq(CREDS))).json()) as Record<string, unknown>;
    expect(disabled).toMatchObject({ exists: false, preferenceEnabled: false });
  });

  it("derives frozen-ness from the live attachment, not the action status", async () => {
    // The §3 self-clear case: STANDBY with the policy still attached, and the
    // manual-freeze case, both have to read as frozen.
    ops.describe.mockResolvedValue(
      liveStatus({ actionStatus: "STANDBY", frozenRoleNames: ["teststack-app-capability-broker-role"] }),
    );
    const body = (await (await statusPOST(jsonReq(CREDS))).json()) as Record<string, unknown>;
    expect(body.frozen).toBe(true);
  });

  it("reports the seeded global gate limit in dollars, beside the budget", async () => {
    const body = (await (await statusPOST(jsonReq(CREDS))).json()) as Record<string, unknown>;
    expect(body.globalCostGateUsd).toBe(20);
  });

  it("reports a deleted global gate as null rather than as zero", async () => {
    // Zero would render as "$0/month" — the tightest possible limit — for a gate
    // that does not exist at all.
    pgState.rows = [];
    const body = (await (await statusPOST(jsonReq(CREDS))).json()) as Record<string, unknown>;
    expect(body.globalCostGateUsd).toBeNull();
  });

  it("still serves the budget when DSQL is unreachable", async () => {
    pgState.queryError = new Error("dsql down");
    const body = (await (await statusPOST(jsonReq(CREDS))).json()) as Record<string, unknown>;
    expect(body.exists).toBe(true);
    expect(body.globalCostGateUsd).toBeNull();
  });

  it("400s without credentials", async () => {
    expect((await statusPOST(jsonReq({}))).status).toBe(400);
  });

  it("502s with the reason when the Manager assume fails", async () => {
    stsState.assumeError = new Error("not authorized to assume");
    const res = await statusPOST(jsonReq(CREDS));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("not authorized to assume");
  });
});

describe("edit route", () => {
  it("rejects an unknown action with a 400", async () => {
    const res = await editPOST(jsonReq({ ...CREDS, action: "obliterate" }));
    expect(res.status).toBe(400);
    expect(ops.ensure).not.toHaveBeenCalled();
  });

  it("rejects a missing action with a 400", async () => {
    expect((await editPOST(jsonReq({ ...CREDS }))).status).toBe(400);
  });

  it.each([
    ["non-numeric", "twenty"],
    ["zero", 0],
    ["negative", -5],
    ["absurdly large", 5_000_000],
    ["NaN", Number.NaN],
  ])("rejects a %s set-limit before touching AWS", async (_label, limitUsd) => {
    const res = await editPOST(jsonReq({ ...CREDS, action: "set-limit", limitUsd }));
    expect(res.status).toBe(400);
    expect(ops.ensure).not.toHaveBeenCalled();
  });

  it("enable performs the AWS mutation AND writes the preference", async () => {
    writeConfig({ ...BASE_CONFIG, bedrockBudget: { enabled: false } });
    const res = await editPOST(jsonReq({ ...CREDS, action: "enable" }));
    expect(res.status).toBe(200);
    expect(ops.ensure).toHaveBeenCalledTimes(1);
    expect(ops.ensure.mock.calls[0][0]).toMatchObject({
      limitMicros: 25_000_000,
      notifyEmail: "operator@example.com",
    });
    expect(readConfig().bedrockBudget).toMatchObject({ enabled: true, limitUsd: 25 });
  });

  it("disable deletes in AWS AND writes the preference", async () => {
    const res = await editPOST(jsonReq({ ...CREDS, action: "disable" }));
    expect(res.status).toBe(200);
    expect(ops.delete).toHaveBeenCalledTimes(1);
    // Persisted so the next install doesn't resurrect a budget the operator
    // deliberately removed.
    expect(readConfig().bedrockBudget).toMatchObject({ enabled: false });
  });

  it("does NOT persist a preference when the AWS mutation failed", async () => {
    ops.ensure.mockRejectedValue(new Error("throttled"));
    writeConfig({ ...BASE_CONFIG, bedrockBudget: { enabled: false, limitUsd: 25 } });
    const res = await editPOST(jsonReq({ ...CREDS, action: "enable" }));
    expect(res.status).toBe(502);
    expect(readConfig().bedrockBudget).toMatchObject({ enabled: false });
  });

  it("set-limit re-prices the budget", async () => {
    const res = await editPOST(jsonReq({ ...CREDS, action: "set-limit", limitUsd: 50 }));
    expect(res.status).toBe(200);
    expect(ops.ensure.mock.calls[0][0]).toMatchObject({ limitMicros: 50_000_000 });
    expect(readConfig().bedrockBudget).toMatchObject({ limitUsd: 50 });
  });

  it("freeze calls freezeBedrock", async () => {
    const res = await editPOST(jsonReq({ ...CREDS, action: "freeze" }));
    expect(res.status).toBe(200);
    expect(ops.freeze).toHaveBeenCalledTimes(1);
    expect(ops.resume).not.toHaveBeenCalled();
  });

  it("resume calls resumeBedrock and reports how it lifted the freeze", async () => {
    ops.resume.mockResolvedValue({ via: "detach", roleNames: ["r"], reverseError: "already reversed" });
    const res = await editPOST(jsonReq({ ...CREDS, action: "resume" }));
    expect(res.status).toBe(200);
    expect((await res.json()).resumed).toMatchObject({ via: "detach" });
  });

  it("surfaces an AWS failure as a 5xx with the message, never a silent ok", async () => {
    ops.freeze.mockRejectedValue(new Error("AccessDenied on AttachRolePolicy"));
    const res = await editPOST(jsonReq({ ...CREDS, action: "freeze" }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string; ok?: boolean };
    expect(body.ok).toBeUndefined();
    expect(body.error).toContain("AccessDenied");
  });

  it("400s enable when no address is on file to subscribe", async () => {
    // Budgets rejects an action without a subscriber, so this must fail loudly
    // rather than create a budget with no action behind it.
    writeConfig({ ...BASE_CONFIG, operatorEmail: undefined });
    const res = await editPOST(jsonReq({ ...CREDS, action: "enable" }));
    expect(res.status).toBe(400);
    expect(ops.ensure).not.toHaveBeenCalled();
  });
});
