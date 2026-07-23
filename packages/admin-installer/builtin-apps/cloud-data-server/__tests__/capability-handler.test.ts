/**
 * Route-level tests for the capability broker handler. A purpose-built
 * in-memory DatabaseClient simulates the four capability tables and, crucially,
 * maintains real ledger state so reserve → scoped-SUM gate check → reconcile is
 * exercised end to end (including a genuine breach). The Bedrock invoker and the
 * content read are injected fakes — no AWS.
 */
import { describe, it, expect } from "vitest";
import type { DatabaseClient } from "@starkeep/storage-aurora-dsql";
import {
  handleCapabilityInvoke,
  type CapabilityHandlerDeps,
  type ContentReadResult,
} from "../src/capability-handler.js";
import type { BedrockInvoker } from "../src/bedrock-client.js";

interface LedgerRow {
  invocation_id: string;
  app_id: string;
  provider: string;
  model: string;
  dimension: string;
  unit: string;
  quantity: number;
  status: string;
  ts: string;
}

interface GateSeed {
  dimension: string;
  unit: string;
  scope_provider?: string | null;
  scope_model?: string | null;
  scope_app_id?: string | null;
  window_kind?: string;
  window_period?: string | null;
  window_seconds?: number | null;
  limit_value: number;
}

/** An in-memory DatabaseClient matching the exact SQL the capability-store
 * emits. Maintains ledger rows so the reserve/sum/reconcile cycle is real. */
class InMemoryCapabilityDb implements DatabaseClient {
  ledger: LedgerRow[] = [];
  constructor(
    private grant: { models: string[]; reports: string[] } | null,
    private gates: GateSeed[],
    private overrides: Record<string, unknown>[] = [],
  ) {}

  async query(text: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    const v = values;
    if (text.includes('"capability_grants"')) {
      return { rows: this.grant ? [{ models_json: JSON.stringify(this.grant.models), reports_json: JSON.stringify(this.grant.reports) }] : [] };
    }
    if (text.includes('"capability_gates"')) {
      return {
        rows: this.gates.map((g, i) => ({
          id: `g${i}`,
          dimension: g.dimension,
          unit: g.unit,
          scope_provider: g.scope_provider ?? null,
          scope_model: g.scope_model ?? null,
          scope_app_id: g.scope_app_id ?? null,
          window_kind: g.window_kind ?? "calendar",
          window_period: g.window_period ?? "month",
          window_seconds: g.window_seconds ?? null,
          limit_value: g.limit_value,
          on_exceed: "deny",
        })),
      };
    }
    if (text.includes('"capability_model_overrides"')) {
      return { rows: this.overrides };
    }
    if (text.startsWith("insert into") && text.includes('"capability_ledger"')) {
      // columns: id, invocation_id, app_id, capability_name, provider, model,
      // dimension, unit, quantity, status
      this.ledger.push({
        invocation_id: String(v[1]),
        app_id: String(v[2]),
        provider: String(v[4]),
        model: String(v[5]),
        dimension: String(v[6]),
        unit: String(v[7]),
        quantity: Number(v[8]),
        status: String(v[9]),
        ts: new Date().toISOString(),
      });
      return { rows: [] };
    }
    if (text.startsWith("select sum") && text.includes('"capability_ledger"')) {
      // params: dimension, unit, 'reserved','committed', startIso, [scope...]
      const [dimension, unit, s1, s2, _startIso, ...scope] = v as string[];
      const statuses = [s1, s2];
      // Present scope columns, in append order: app_id, provider, model.
      const scopeCols: string[] = [];
      if (text.includes('"app_id" =')) scopeCols.push("app_id");
      if (text.includes('"provider" =')) scopeCols.push("provider");
      if (text.includes('"model" =')) scopeCols.push("model");
      const total = this.ledger
        .filter((r) => r.dimension === dimension && r.unit === unit && statuses.includes(r.status))
        .filter((r) => scopeCols.every((c, i) => (r as unknown as Record<string, unknown>)[c] === scope[i]))
        .reduce((sum, r) => sum + r.quantity, 0);
      return { rows: [{ total }] };
    }
    if (text.startsWith("update") && text.includes('"capability_ledger"')) {
      if (text.includes('"quantity" =')) {
        // reconcile: quantity, status, invocation_id, dimension, unit, 'reserved'
        const [qty, status, inv, dim, unit] = v as [number, string, string, string, string];
        for (const r of this.ledger) {
          if (r.invocation_id === inv && r.dimension === dim && r.unit === unit && r.status === "reserved") {
            r.quantity = qty;
            r.status = status;
          }
        }
      } else {
        // release: status, invocation_id, 'reserved'
        const [status, inv] = v as [string, string];
        for (const r of this.ledger) {
          if (r.invocation_id === inv && r.status === "reserved") r.status = status;
        }
      }
      return { rows: [] };
    }
    if (text.startsWith("select count") && text.includes('"capability_ledger"')) {
      const [inv, dim, unit, status] = v as [string, string, string, string];
      const n = this.ledger.filter(
        (r) => r.invocation_id === inv && r.dimension === dim && r.unit === unit && r.status === status,
      ).length;
      return { rows: [{ n }] };
    }
    throw new Error(`InMemoryCapabilityDb: unhandled SQL: ${text}`);
  }
  async end() {}
}

const fakeInvoker: BedrockInvoker = {
  async converse() {
    return { text: "a cat on a mat", inputTokens: 1200, outputTokens: 8 };
  },
  // eslint-disable-next-line require-yield
  async *converseStream() {
    throw new Error("not used");
  },
};

const imageContent = async (): Promise<ContentReadResult> => ({
  ok: true,
  content: { bytes: new Uint8Array([1, 2, 3]), sizeBytes: 2048, image: { format: "jpeg", bytes: new Uint8Array([1, 2, 3]) } },
});

function baseDeps(
  db: InMemoryCapabilityDb,
  over: Partial<CapabilityHandlerDeps> = {},
): CapabilityHandlerDeps {
  return {
    appId: "photos",
    capabilityName: "bedrock.invoke",
    body: {
      model: "anthropic.claude-haiku-4-5",
      prompt: "Describe this image.",
      contentRef: { recordId: "rec_1" },
      maxTokens: 100,
    },
    capClient: db,
    readContent: imageContent,
    assumeCapabilityCreds: async () => ({ accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" }),
    invoker: fakeInvoker,
    region: "us-east-1",
    timeZone: "UTC",
    ...over,
  };
}

describe("capability handler", () => {
  it("invokes and returns text + usage + reconciled cost with no gates", async () => {
    const db = new InMemoryCapabilityDb({ models: ["anthropic.claude-haiku-4-5"], reports: [] }, []);
    const res = await handleCapabilityInvoke(baseDeps(db));
    expect(res.statusCode).toBe(200);
    const body = res.body as { text: string; usage: { inputTokens: number }; estCostUsd: number };
    expect(body.text).toBe("a cat on a mat");
    expect(body.usage.inputTokens).toBe(1200);
    // ledger reconciled: reserved rows promoted to committed with actuals.
    const committed = db.ledger.filter((r) => r.status === "committed");
    expect(committed.some((r) => r.dimension === "input" && r.unit === "tokens" && r.quantity === 1200)).toBe(true);
    expect(committed.some((r) => r.dimension === "output" && r.unit === "tokens" && r.quantity === 8)).toBe(true);
    // cost re-derived from actual tokens (1200*$1/MTok + 8*$5/MTok)
    expect(body.estCostUsd).toBeCloseTo((1200 * 1) / 1e6 + (8 * 5) / 1e6);
  });

  it("returns not_granted (403) when the app has no capability grant", async () => {
    const db = new InMemoryCapabilityDb(null, []);
    const res = await handleCapabilityInvoke(baseDeps(db));
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toBe("not_granted");
  });

  it("returns model_not_granted (403) for a model outside the approved set", async () => {
    const db = new InMemoryCapabilityDb({ models: ["anthropic.claude-opus-4-8"], reports: [] }, []);
    const res = await handleCapabilityInvoke(baseDeps(db));
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toBe("model_not_granted");
  });

  it("propagates a content read failure", async () => {
    const db = new InMemoryCapabilityDb({ models: ["anthropic.claude-haiku-4-5"], reports: [] }, []);
    const res = await handleCapabilityInvoke(
      baseDeps(db, { readContent: async () => ({ ok: false, status: 403, message: "content_forbidden" }) }),
    );
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toBe("content_forbidden");
  });

  it("denies (429) when a request cost gate is already exceeded, and releases the reservation", async () => {
    // A $0-limit per-app cost gate: any reservation cost > 0 breaches.
    const db = new InMemoryCapabilityDb(
      { models: ["anthropic.claude-haiku-4-5"], reports: [] },
      [{ dimension: "cost", unit: "usd", scope_app_id: "photos", limit_value: 0 }],
    );
    const res = await handleCapabilityInvoke(baseDeps(db));
    expect(res.statusCode).toBe(429);
    expect((res.body as { error: string }).error).toBe("gate_exceeded");
    // Reservation released → no reserved/committed rows remain in the SUM.
    expect(db.ledger.every((r) => r.status === "released")).toBe(true);
  });

  it("enforces a request-count gate across successive calls", async () => {
    const db = new InMemoryCapabilityDb(
      { models: ["anthropic.claude-haiku-4-5"], reports: [] },
      [{ dimension: "requests", unit: "all", limit_value: 1 }],
    );
    const first = await handleCapabilityInvoke(baseDeps(db));
    expect(first.statusCode).toBe(200);
    const second = await handleCapabilityInvoke(baseDeps(db));
    expect(second.statusCode).toBe(429);
  });

  it("FAILS CLOSED (403) when a gate targets an undeclared non-generic dimension", async () => {
    const db = new InMemoryCapabilityDb(
      { models: ["anthropic.claude-haiku-4-5"], reports: [] }, // no reports declared
      [{ dimension: "input", unit: "megapixels", scope_app_id: "photos", limit_value: 1000 }],
    );
    const res = await handleCapabilityInvoke(baseDeps(db));
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toBe("undeclared_dimension");
    // Never reserved (fail-closed happens before the ledger write).
    expect(db.ledger).toHaveLength(0);
  });

  it("allows an app-reported dimension gate once declared", async () => {
    const db = new InMemoryCapabilityDb(
      { models: ["anthropic.claude-haiku-4-5"], reports: ["input:megapixels"] },
      [{ dimension: "input", unit: "megapixels", scope_app_id: "photos", limit_value: 1000 }],
    );
    const res = await handleCapabilityInvoke(
      baseDeps(db, {
        body: {
          model: "anthropic.claude-haiku-4-5",
          prompt: "caption",
          contentRef: { recordId: "rec_1" },
          maxTokens: 50,
          reports: { "input:megapixels": 12 },
        },
      }),
    );
    expect(res.statusCode).toBe(200);
  });

  it("releases the reservation and 502s when the invoker throws", async () => {
    const db = new InMemoryCapabilityDb({ models: ["anthropic.claude-haiku-4-5"], reports: [] }, []);
    const res = await handleCapabilityInvoke(
      baseDeps(db, {
        invoker: {
          async converse() {
            throw new Error("bedrock exploded");
          },
          async *converseStream() {},
        },
      }),
    );
    expect(res.statusCode).toBe(502);
    expect(db.ledger.every((r) => r.status === "released")).toBe(true);
  });

  it("404s an unknown capability name", async () => {
    const db = new InMemoryCapabilityDb({ models: ["anthropic.claude-haiku-4-5"], reports: [] }, []);
    const res = await handleCapabilityInvoke(baseDeps(db, { capabilityName: "bedrock.knowledgeBase" }));
    expect(res.statusCode).toBe(404);
  });
});
