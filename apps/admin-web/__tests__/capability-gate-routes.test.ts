/**
 * The operator gate API routes (plan §3.5) — the only way a limit that the app
 * did not itself request can enter `shared.capability_gates`.
 *
 * What matters at the route layer: nothing unenforceable reaches the table, the
 * upsert carries every column (a stale one would leave the operator looking at a
 * limit that isn't the one being enforced), and neither write path can touch an
 * app-consent gate.
 *
 * `pg` and the DSQL token signer are module-mocked; the routes' real Kysely
 * composition and validation run unchanged.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextRequest } from "next/server";
import { DIMENSION_UNIT_SPECS } from "@starkeep/protocol-primitives";
import type { GateInput, GateListResponse } from "../src/lib/capability-gates";

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

const CREDS = { accessKeyId: "AKIA", secretAccessKey: "secret", sessionToken: "token" };

let dataDir: string;
let gatesPOST: (req: NextRequest) => Promise<Response>;
let editPOST: (req: NextRequest) => Promise<Response>;
let editDELETE: (req: NextRequest) => Promise<Response>;

function jsonReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

const GOOD_CONFIG = {
  stackPrefix: "teststack",
  userPoolId: "us-east-1_abc123",
  auroraEndpoint: "fake.dsql.us-east-1.on.aws",
};

function writeConfig(config: unknown): void {
  writeFileSync(
    join(dataDir, "config.json"),
    typeof config === "string" ? config : JSON.stringify(config),
  );
}

function gate(over: Partial<GateInput> = {}): GateInput {
  return {
    capabilityName: "bedrock.invoke",
    dimension: "cost",
    unit: "usd",
    window: { kind: "calendar", period: "month" },
    limit: 50,
    ...over,
  };
}

/** A DSQL gate row as the list route would read it. */
function dbRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "operator:01ABC",
    capability_name: "bedrock.invoke",
    dimension: "cost",
    unit: "usd",
    scope_provider: null,
    scope_model: null,
    scope_app_id: null,
    window_kind: "calendar",
    window_period: "month",
    window_seconds: null,
    limit_value: 50,
    on_exceed: "deny",
    origin: "operator",
    created_at: null,
    ...over,
  };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "adminweb-capgates-"));
  process.env.STARKEEP_DIR = dataDir;
  writeConfig(GOOD_CONFIG);
  ({ POST: gatesPOST } = await import("../app/api/capabilities/gates/route"));
  const edit = await import("../app/api/capabilities/gates/edit/route");
  editPOST = edit.POST;
  editDELETE = edit.DELETE;
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
// List
// ---------------------------------------------------------------------------

describe("POST /api/capabilities/gates", () => {
  it("returns the gate rows plus the catalogue the editor needs", async () => {
    pgState.rows = [dbRow()];
    const res = await gatesPOST(jsonReq(CREDS));
    expect(res.status).toBe(200);
    const body = (await res.json()) as GateListResponse;
    expect(body.gates).toHaveLength(1);
    expect(body.gates[0]).toMatchObject({ id: "operator:01ABC", limit: 50, editable: true });
    // The classification that decides the UI caveat comes from the platform, not
    // a client-side copy that could drift.
    expect(body.dimensions).toHaveLength(DIMENSION_UNIT_SPECS.length);
    expect(body.capabilities).toContain("bedrock.invoke");
    expect(body.providers).toContain("anthropic");
  });

  it("returns an app-consent gate as read-only alongside operator gates", async () => {
    pgState.rows = [
      dbRow(),
      dbRow({
        id: "consent:photos:bedrock.invoke",
        origin: "app-consent",
        scope_app_id: "photos",
        limit_value: 20,
      }),
    ];
    const body = (await (await gatesPOST(jsonReq(CREDS))).json()) as GateListResponse;
    const consent = body.gates.find((g) => g.origin === "app-consent")!;
    expect(consent.editable).toBe(false);
    expect(consent.limit).toBe(20);
    expect(consent.scope).toEqual({ appId: "photos" });
  });

  it("returns an empty list (not an error) when no gate has ever been set", async () => {
    const body = (await (await gatesPOST(jsonReq(CREDS))).json()) as GateListResponse;
    expect(body.gates).toEqual([]);
  });

  it("selects every gate column and closes the pool", async () => {
    await gatesPOST(jsonReq(CREDS));
    const sql = pgState.queries[0]!.sql;
    expect(sql).toContain('"shared"."capability_gates"');
    for (const col of [
      "id",
      "capability_name",
      "dimension",
      "unit",
      "scope_provider",
      "scope_model",
      "scope_app_id",
      "window_kind",
      "window_period",
      "window_seconds",
      "limit_value",
      "origin",
    ]) {
      expect(sql, col).toContain(`"${col}"`);
    }
    expect(pgState.ended).toBe(1);
  });

  it("does NOT filter by capability — an operator sees every gate that exists", async () => {
    expect(pgState.queries).toHaveLength(0);
    await gatesPOST(jsonReq(CREDS));
    expect(pgState.queries[0]!.params).toEqual([]);
  });

  it("502s a DSQL query failure and still closes the pool", async () => {
    pgState.queryError = new Error("relation does not exist");
    const res = await gatesPOST(jsonReq(CREDS));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/DSQL query failed/);
    expect(pgState.ended).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Write validation
// ---------------------------------------------------------------------------

describe("POST /api/capabilities/gates/edit — validation", () => {
  it("400s without ever connecting when the gate is unenforceable", async () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ["no gate at all", undefined, /gate required/],
      ["unmetered pair", gate({ dimension: "gpu", unit: "seconds" }), /not a metered/],
      ["unknown capability", gate({ capabilityName: "bedrock.agent" }), /Unknown capability/],
      ["negative limit", gate({ limit: -1 }), /non-negative/],
      ["non-numeric limit", gate({ limit: "50" as unknown as number }), /non-negative/],
      ["zero-second burst", gate({ window: { kind: "burst", seconds: 0 } }), /positive whole/],
      ["unknown period", gate({ window: { kind: "calendar", period: "day" } as never }), /week or month/],
      ["unknown provider", gate({ scope: { provider: "acme" } }), /Unknown provider/],
    ];
    for (const [name, g, match] of cases) {
      const res = await editPOST(jsonReq({ ...CREDS, gate: g }));
      expect(res.status, name).toBe(400);
      expect((await res.json()).error, name).toMatch(match);
    }
    // Validation happens before the DSQL connection, so a bad gate never opens one.
    expect(pgState.queries).toHaveLength(0);
    expect(pgState.ended).toBe(0);
  });

  it("400s an attempt to rewrite an app-consent gate", async () => {
    const res = await editPOST(
      jsonReq({ ...CREDS, gate: gate({ id: "consent:photos:bedrock.invoke", limit: 5 }) }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Only operator-created gates can be edited/);
    expect(pgState.queries).toHaveLength(0);
  });

  it("tolerates a body that is not JSON at all", async () => {
    const badReq = {
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as NextRequest;
    const res = await editPOST(badReq);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("gate required");
  });
});

// ---------------------------------------------------------------------------
// Write behaviour
// ---------------------------------------------------------------------------

describe("POST /api/capabilities/gates/edit — writes", () => {
  it("inserts a new operator gate and returns its minted id", async () => {
    const res = await editPOST(jsonReq({ ...CREDS, gate: gate() }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body.ok).toBe(true);
    expect(body.id.startsWith("operator:")).toBe(true);

    const q = pgState.queries[0]!;
    expect(q.sql).toContain('insert into "shared"."capability_gates"');
    expect(q.params).toContain(body.id);
    expect(q.params).toContain("bedrock.invoke");
    expect(q.params).toContain(50);
    // deny-only, and marked as the operator's own row.
    expect(q.params).toContain("deny");
    expect(q.params).toContain("operator");
    expect(pgState.ended).toBe(1);
  });

  it("upserts on id so editing a gate replaces it rather than duplicating the limit", async () => {
    const res = await editPOST(
      jsonReq({ ...CREDS, gate: gate({ id: "operator:FIXED", limit: 10 }) }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe("operator:FIXED");
    expect(pgState.queries[0]!.sql).toContain('on conflict ("id") do update');
  });

  it("carries EVERY editable column through the DO UPDATE set", async () => {
    // A column left out of the upsert would keep its old value, so the operator
    // would be shown one limit while a different one is enforced.
    await editPOST(jsonReq({ ...CREDS, gate: gate({ id: "operator:FIXED" }) }));
    const sql = pgState.queries[0]!.sql;
    const doUpdate = sql.slice(sql.indexOf("do update"));
    for (const col of [
      "capability_name",
      "dimension",
      "unit",
      "scope_provider",
      "scope_model",
      "scope_app_id",
      "window_kind",
      "window_period",
      "window_seconds",
      "limit_value",
      "on_exceed",
      "origin",
    ]) {
      expect(doUpdate, col).toContain(`"${col}" = "excluded"."${col}"`);
    }
  });

  it("persists a per-provider burst gate exactly as posted", async () => {
    await editPOST(
      jsonReq({
        ...CREDS,
        gate: gate({
          dimension: "requests",
          unit: "all",
          scope: { provider: "anthropic" },
          window: { kind: "burst", seconds: 30 },
          limit: 100,
        }),
      }),
    );
    const params = pgState.queries[0]!.params;
    expect(params).toContain("requests");
    expect(params).toContain("anthropic");
    expect(params).toContain("burst");
    expect(params).toContain(30);
    expect(params).toContain(100);
  });

  it("persists a per-app gate whose scope is narrower than any consent gate", async () => {
    // This is how an operator tightens a limit an app requested for itself.
    await editPOST(
      jsonReq({ ...CREDS, gate: gate({ scope: { appId: "photos" }, limit: 5 }) }),
    );
    expect(pgState.queries[0]!.params).toContain("photos");
    expect(pgState.queries[0]!.params).toContain(5);
  });

  it("502s a DSQL write failure and closes the pool", async () => {
    pgState.queryError = new Error("permission denied");
    const res = await editPOST(jsonReq({ ...CREDS, gate: gate() }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/DSQL write failed: permission denied/);
    expect(pgState.ended).toBe(1);
  });
});

describe("DELETE /api/capabilities/gates/edit", () => {
  it("400s without a gateId", async () => {
    const res = await editDELETE(jsonReq(CREDS));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("gateId required");
    expect(pgState.queries).toHaveLength(0);
  });

  it("deletes exactly the named operator gate", async () => {
    const res = await editDELETE(jsonReq({ ...CREDS, gateId: "operator:01ABC" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(pgState.queries[0]!.sql).toContain('delete from "shared"."capability_gates"');
    expect(pgState.queries[0]!.params).toEqual(["operator:01ABC"]);
  });

  it("REFUSES to delete an app-consent gate (that would REMOVE a spend limit)", async () => {
    const res = await editDELETE(jsonReq({ ...CREDS, gateId: "consent:photos:bedrock.invoke" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/removed when that app is uninstalled/);
    expect(pgState.queries).toHaveLength(0);
  });

  it("502s a DSQL delete failure", async () => {
    pgState.queryError = new Error("boom");
    const res = await editDELETE(jsonReq({ ...CREDS, gateId: "operator:01ABC" }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/DSQL delete failed/);
  });
});

// ---------------------------------------------------------------------------
// Shared connection error branches
// ---------------------------------------------------------------------------

describe("connectInstallerDsql branches on the gate routes", () => {
  it("400s every route when the cloud is not configured", async () => {
    rmSync(join(dataDir, "config.json"));
    expect((await gatesPOST(jsonReq(CREDS))).status).toBe(400);
    expect((await editPOST(jsonReq({ ...CREDS, gate: gate() }))).status).toBe(400);
    expect((await editDELETE(jsonReq({ ...CREDS, gateId: "operator:01ABC" }))).status).toBe(400);
  });

  it("400s incomplete operator credentials", async () => {
    for (const drop of ["accessKeyId", "secretAccessKey", "sessionToken"] as const) {
      const creds: Record<string, unknown> = { ...CREDS };
      delete creds[drop];
      const res = await gatesPOST(jsonReq(creds));
      expect(res.status, drop).toBe(400);
    }
  });

  it("500s when the DSQL auth token can't be signed", async () => {
    signerState.error = new Error("clock skew");
    const res = await editPOST(jsonReq({ ...CREDS, gate: gate() }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/Failed to sign DSQL token/);
  });
});
