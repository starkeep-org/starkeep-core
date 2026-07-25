/**
 * The operator model-registry API routes (plan §3.6) and the `dsql-admin`
 * connection helper's error branches.
 *
 * These routes are the only way an operator changes what the broker charges for
 * a model, so their validation (id shape, the pricing pair, the
 * operator-defined-needs-a-provider rule) and the empty-override→DELETE branch
 * decide whether a bad edit silently lands as an all-NULL row.
 *
 * `pg` and the DSQL token signer are module-mocked; the routes' real Kysely
 * composition and validation run unchanged.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextRequest } from "next/server";

interface Recorded {
  sql: string;
  params: unknown[];
}

const pgState = {
  queries: [] as Recorded[],
  rows: [] as Record<string, unknown>[],
  queryError: null as Error | null,
  ended: 0,
};
const signerState = { error: null as Error | null };

vi.mock("pg", () => {
  class FakePool {
    async query(sql: string, params?: unknown[]) {
      pgState.queries.push({ sql, params: params ?? [] });
      if (pgState.queryError) throw pgState.queryError;
      return { rows: pgState.rows, rowCount: pgState.rows.length };
    }
    async end() {
      pgState.ended++;
    }
  }
  return { default: { Pool: FakePool }, Pool: FakePool };
});

vi.mock("@aws-sdk/dsql-signer", () => ({
  DsqlSigner: class {
    async getDbConnectAuthToken() {
      if (signerState.error) throw signerState.error;
      return "fake-token";
    }
  },
}));

const CREDS = {
  accessKeyId: "AKIA",
  secretAccessKey: "secret",
  sessionToken: "token",
};

let dataDir: string;
let modelsPOST: (req: NextRequest) => Promise<Response>;
let overridePOST: (req: NextRequest) => Promise<Response>;
let overrideDELETE: (req: NextRequest) => Promise<Response>;

/** A NextRequest-shaped stub — the routes only ever call `req.json()`. */
function jsonReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function writeConfig(config: unknown): void {
  writeFileSync(
    join(dataDir, "config.json"),
    typeof config === "string" ? config : JSON.stringify(config),
  );
}

const GOOD_CONFIG = {
  stackPrefix: "teststack",
  userPoolId: "us-east-1_abc123",
  auroraEndpoint: "fake.dsql.us-east-1.on.aws",
};

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "adminweb-capmodels-"));
  process.env.STARKEEP_DIR = dataDir;
  writeConfig(GOOD_CONFIG);
  ({ POST: modelsPOST } = await import("../app/api/capabilities/models/route"));
  const override = await import("../app/api/capabilities/models/override/route");
  overridePOST = override.POST;
  overrideDELETE = override.DELETE;
});

beforeEach(() => {
  pgState.queries = [];
  pgState.rows = [];
  pgState.queryError = null;
  pgState.ended = 0;
  signerState.error = null;
  writeConfig(GOOD_CONFIG);
});

// ---------------------------------------------------------------------------
// GET-equivalent: the registry read
// ---------------------------------------------------------------------------

describe("POST /api/capabilities/models", () => {
  it("returns the effective registry built from the override rows", async () => {
    pgState.rows = [
      {
        model_id: "anthropic.claude-haiku-4-5",
        provider: null,
        inference_profile_id: null,
        inference_profile_cleared: null,
        vision: null,
        pricing_json: JSON.stringify({ "input:tokens": 2 / 1e6, "output:tokens": 8 / 1e6 }),
        estimates_json: null,
      },
    ];
    const res = await modelsPOST(jsonReq(CREDS));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      models: Array<{ modelId: string; effective: { inputPerMTok?: number } }>;
    };
    const haiku = body.models.find((m) => m.modelId === "anthropic.claude-haiku-4-5")!;
    expect(haiku.effective.inputPerMTok).toBe(2);
    // Every platform model is present, not just the overridden one.
    expect(body.models.length).toBeGreaterThan(1);
  });

  it("selects the override columns and closes the pool", async () => {
    await modelsPOST(jsonReq(CREDS));
    expect(pgState.queries[0]!.sql).toContain('"shared"."capability_model_overrides"');
    expect(pgState.queries[0]!.sql).toContain('"inference_profile_cleared"');
    expect(pgState.ended).toBe(1);
  });

  it("502s a DSQL query failure (and still closes the pool)", async () => {
    pgState.queryError = new Error("relation does not exist");
    const res = await modelsPOST(jsonReq(CREDS));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/DSQL query failed: relation does not exist/);
    expect(pgState.ended).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Override write validation
// ---------------------------------------------------------------------------

describe("POST /api/capabilities/models/override — validation", () => {
  it("400s a missing modelId without connecting", async () => {
    const res = await overridePOST(jsonReq({ ...CREDS, override: {} }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("modelId required");
    expect(pgState.queries).toHaveLength(0);
  });

  it("400s a modelId that is not provider-prefixed", async () => {
    for (const modelId of ["haiku", "Anthropic.Claude", "anthropic.", ".claude", "an thropic.x"]) {
      const res = await overridePOST(
        jsonReq({ ...CREDS, modelId, override: { provider: "anthropic" } }),
      );
      expect(res.status, modelId).toBe(400);
      expect((await res.json()).error).toMatch(/provider-prefixed id/);
    }
  });

  it("accepts a well-formed operator-defined id", async () => {
    const res = await overridePOST(
      jsonReq({ ...CREDS, modelId: "acme.model-1_v2", override: { provider: "amazon" } }),
    );
    expect(res.status).toBe(200);
  });

  it("does not re-validate the id shape for a PLATFORM model", async () => {
    // Platform ids are in the registry by definition; the regex is only a guard
    // for operator-typed ids.
    const res = await overridePOST(
      jsonReq({ ...CREDS, modelId: "amazon.nova-reel-v1:1", override: { inputPerMTok: 1, outputPerMTok: 2 } }),
    );
    expect(res.status).toBe(200);
  });

  it("400s a half-set pricing pair (either direction)", async () => {
    const onlyIn = await overridePOST(
      jsonReq({ ...CREDS, modelId: "anthropic.claude-haiku-4-5", override: { inputPerMTok: 2 } }),
    );
    expect(onlyIn.status).toBe(400);
    expect((await onlyIn.json()).error).toBe("input and output $/MTok must be set together");

    const onlyOut = await overridePOST(
      jsonReq({ ...CREDS, modelId: "anthropic.claude-haiku-4-5", override: { outputPerMTok: 8 } }),
    );
    expect(onlyOut.status).toBe(400);
    expect(pgState.queries).toHaveLength(0);
  });

  it("accepts a zero-priced pair (0 is a number, not 'unset')", async () => {
    const res = await overridePOST(
      jsonReq({
        ...CREDS,
        modelId: "anthropic.claude-haiku-4-5",
        override: { inputPerMTok: 0, outputPerMTok: 0 },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("400s an operator-DEFINED model with no provider (it can't be gated/metered)", async () => {
    const res = await overridePOST(
      jsonReq({ ...CREDS, modelId: "acme.custom-1", override: { inputPerMTok: 1, outputPerMTok: 2 } }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/requires a provider/);
    expect(pgState.queries).toHaveLength(0);
  });

  it("does NOT require a provider for a platform model (it inherits one)", async () => {
    const res = await overridePOST(
      jsonReq({
        ...CREDS,
        modelId: "anthropic.claude-haiku-4-5",
        override: { inputPerMTok: 2, outputPerMTok: 8 },
      }),
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Override write behaviour
// ---------------------------------------------------------------------------

describe("POST /api/capabilities/models/override — writes", () => {
  it("upserts the sparse override row on model_id", async () => {
    const res = await overridePOST(
      jsonReq({
        ...CREDS,
        modelId: "anthropic.claude-haiku-4-5",
        override: { inputPerMTok: 2, outputPerMTok: 8, vision: false },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const q = pgState.queries[0]!;
    expect(q.sql).toContain('insert into "shared"."capability_model_overrides"');
    expect(q.sql).toContain('on conflict ("model_id") do update');
    expect(q.params[0]).toBe("anthropic.claude-haiku-4-5");
    // $/MTok is stored divided down to USD per single token.
    expect(String(q.params.find((p) => typeof p === "string" && p.includes("input:tokens")))).toBe(
      JSON.stringify({ "input:tokens": 2 / 1e6, "output:tokens": 8 / 1e6 }),
    );
    expect(pgState.ended).toBe(1);
  });

  it("DELETEs instead of persisting an all-NULL row for an empty PLATFORM override", async () => {
    const res = await overridePOST(
      jsonReq({ ...CREDS, modelId: "anthropic.claude-haiku-4-5", override: {} }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cleared: true });
    expect(pgState.queries).toHaveLength(1);
    expect(pgState.queries[0]!.sql).toContain('delete from "shared"."capability_model_overrides"');
    expect(pgState.queries[0]!.params).toEqual(["anthropic.claude-haiku-4-5"]);
  });

  it("treats a missing override object as an empty one", async () => {
    const res = await overridePOST(jsonReq({ ...CREDS, modelId: "anthropic.claude-haiku-4-5" }));
    expect(await res.json()).toEqual({ ok: true, cleared: true });
  });

  it("does NOT delete for an operator-defined model (that would erase the model)", async () => {
    // An operator-defined model's row IS the model; only a platform model can
    // fall back to a default.
    const res = await overridePOST(
      jsonReq({ ...CREDS, modelId: "acme.custom-1", override: { provider: "amazon" } }),
    );
    expect(res.status).toBe(200);
    expect(pgState.queries[0]!.sql).toContain("insert into");
  });

  it("persists an explicitly-cleared inference profile as its own flag", async () => {
    await overridePOST(
      jsonReq({
        ...CREDS,
        modelId: "anthropic.claude-haiku-4-5",
        // An explicit null (vs an absent key) means "clear it", which is a real
        // override — so this must NOT take the empty→delete branch.
        override: { inferenceProfileId: null },
      }),
    );
    const q = pgState.queries[0]!;
    expect(q.sql).toContain("insert into");
    expect(q.params).toContain(true); // inference_profile_cleared
  });

  it("502s a DSQL write failure and closes the pool", async () => {
    pgState.queryError = new Error("permission denied");
    const res = await overridePOST(
      jsonReq({ ...CREDS, modelId: "acme.custom-1", override: { provider: "amazon" } }),
    );
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/DSQL write failed: permission denied/);
    expect(pgState.ended).toBe(1);
  });
});

describe("DELETE /api/capabilities/models/override", () => {
  it("400s without a modelId", async () => {
    const res = await overrideDELETE(jsonReq(CREDS));
    expect(res.status).toBe(400);
    expect(pgState.queries).toHaveLength(0);
  });

  it("deletes exactly the named model's override row", async () => {
    const res = await overrideDELETE(jsonReq({ ...CREDS, modelId: "acme.custom-1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(pgState.queries[0]!.sql).toContain('delete from "shared"."capability_model_overrides"');
    expect(pgState.queries[0]!.params).toEqual(["acme.custom-1"]);
  });

  it("does not require the id to be platform-known (an operator model can be removed)", async () => {
    const res = await overrideDELETE(jsonReq({ ...CREDS, modelId: "whatever-shape" }));
    expect(res.status).toBe(200);
  });

  it("502s a DSQL delete failure", async () => {
    pgState.queryError = new Error("boom");
    const res = await overrideDELETE(jsonReq({ ...CREDS, modelId: "acme.custom-1" }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/DSQL delete failed/);
  });
});

// ---------------------------------------------------------------------------
// dsql-admin connection error branches (shared by all three handlers)
// ---------------------------------------------------------------------------

describe("connectInstallerDsql error branches", () => {
  it("400s when the cloud is not configured", async () => {
    rmSync(join(dataDir, "config.json"));
    const res = await modelsPOST(jsonReq(CREDS));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Cloud is not configured/);
  });

  it("500s when config.json is not valid JSON", async () => {
    writeConfig("{not json");
    const res = await modelsPOST(jsonReq(CREDS));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/not valid JSON/);
  });

  it("400s when config.json is missing a required field", async () => {
    for (const missing of ["stackPrefix", "userPoolId", "auroraEndpoint"] as const) {
      const partial: Record<string, unknown> = { ...GOOD_CONFIG };
      delete partial[missing];
      writeConfig(partial);
      const res = await modelsPOST(jsonReq(CREDS));
      expect(res.status, missing).toBe(400);
      expect((await res.json()).error).toMatch(/missing required fields/);
    }
  });

  it("400s when the operator credentials are incomplete", async () => {
    for (const drop of ["accessKeyId", "secretAccessKey", "sessionToken"] as const) {
      const creds: Record<string, unknown> = { ...CREDS };
      delete creds[drop];
      const res = await modelsPOST(jsonReq(creds));
      expect(res.status, drop).toBe(400);
      expect((await res.json()).error).toMatch(/required/);
    }
  });

  it("500s when the DSQL auth token can't be signed", async () => {
    signerState.error = new Error("clock skew");
    const res = await modelsPOST(jsonReq(CREDS));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/Failed to sign DSQL token: clock skew/);
  });

  it("returns the same connection errors from the write routes", async () => {
    rmSync(join(dataDir, "config.json"));
    const post = await overridePOST(
      jsonReq({ ...CREDS, modelId: "acme.custom-1", override: { provider: "amazon" } }),
    );
    expect(post.status).toBe(400);
    const del = await overrideDELETE(jsonReq({ ...CREDS, modelId: "acme.custom-1" }));
    expect(del.status).toBe(400);
  });

  it("tolerates a body that is not JSON at all", async () => {
    const badReq = {
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as NextRequest;
    // The route catches the parse failure and falls through to credential
    // validation rather than throwing a 500 out of the handler.
    const res = await modelsPOST(badReq);
    expect(res.status).toBe(400);
  });
});
