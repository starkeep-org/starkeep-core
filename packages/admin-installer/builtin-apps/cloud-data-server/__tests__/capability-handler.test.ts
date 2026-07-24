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
  handleCapabilityInvokeStream,
  type CapabilityHandlerDeps,
  type ContentReadResult,
  type SyncImageOutput,
} from "../src/capability-handler.js";
import {
  buildImageModelInput,
  type BedrockInvoker,
  type BedrockImageInvoker,
  type BedrockImageGenRequest,
} from "../src/bedrock-client.js";

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
  content: { sizeBytes: 2048, image: { format: "jpeg", bytes: new Uint8Array([1, 2, 3]) } },
});

/** S3-location content: no inline bytes, an s3Uri image + the s3Key the broker
 * must scope the capability assume's session policy to (plan §3.4). */
const s3LocationContent = async (): Promise<ContentReadResult> => ({
  ok: true,
  content: {
    sizeBytes: 12_000_000,
    image: { format: "jpeg", s3Uri: "s3://stk-files-1/shared/image/ab/cd/pic.jpg", bucketOwner: "111122223333" },
    s3Key: { bucket: "stk-files-1", key: "shared/image/ab/cd/pic.jpg" },
  },
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

  it("rejects a non-text (video) model on the inline route — must use async (§3.8)", async () => {
    const db = new InMemoryCapabilityDb({ models: ["amazon.nova-reel-v1:1"], reports: [] }, []);
    const res = await handleCapabilityInvoke(
      baseDeps(db, { body: { model: "amazon.nova-reel-v1:1", prompt: "a cat surfing" } }),
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe("output_requires_async");
    // Guard fires before any reservation is written.
    expect(db.ledger).toHaveLength(0);
  });
});

describe("capability handler — S3-location delivery (plan §3.4)", () => {
  it("passes NO session scope on the inline path", async () => {
    const db = new InMemoryCapabilityDb({ models: ["anthropic.claude-haiku-4-5"], reports: [] }, []);
    let capturedScope: unknown = "unset";
    const res = await handleCapabilityInvoke(
      baseDeps(db, {
        readContent: imageContent,
        assumeCapabilityCreds: async (scope) => {
          capturedScope = scope;
          return { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" };
        },
      }),
    );
    expect(res.statusCode).toBe(200);
    // Inline: the capability role is assumed with no session policy (cacheable).
    expect(capturedScope).toBeUndefined();
  });

  it("scopes the capability assume to exactly the referenced S3 key, and delivers by s3Uri", async () => {
    const db = new InMemoryCapabilityDb({ models: ["anthropic.claude-haiku-4-5"], reports: [] }, []);
    let capturedScope: { s3Keys?: { bucket: string; key: string }[] } | undefined;
    let capturedImages: unknown;
    const spyInvoker: BedrockInvoker = {
      async converse(req) {
        capturedImages = req.images;
        return { text: "ok", inputTokens: 10, outputTokens: 2 };
      },
      // eslint-disable-next-line require-yield
      async *converseStream() {
        throw new Error("not used");
      },
    };
    const res = await handleCapabilityInvoke(
      baseDeps(db, {
        readContent: s3LocationContent,
        invoker: spyInvoker,
        assumeCapabilityCreds: async (scope) => {
          capturedScope = scope;
          return { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" };
        },
      }),
    );
    expect(res.statusCode).toBe(200);
    // The broker must fasten the single-key belt on the S3-location assume.
    expect(capturedScope?.s3Keys).toEqual([
      { bucket: "stk-files-1", key: "shared/image/ab/cd/pic.jpg" },
    ]);
    // Bedrock receives the image by S3 URI, not inline bytes.
    expect(capturedImages).toEqual([
      { format: "jpeg", s3Uri: "s3://stk-files-1/shared/image/ab/cd/pic.jpg", bucketOwner: "111122223333" },
    ]);
  });

  it("scopes the session on the streaming S3-location path too", async () => {
    const db = new InMemoryCapabilityDb({ models: ["anthropic.claude-haiku-4-5"], reports: [] }, []);
    let capturedScope: { s3Keys?: { bucket: string; key: string }[] } | undefined;
    const result = await handleCapabilityInvokeStream(
      baseDeps(db, {
        readContent: s3LocationContent,
        invoker: streamInvoker,
        assumeCapabilityCreds: async (scope) => {
          capturedScope = scope;
          return { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" };
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an open stream");
    // Drain the stream so the invoke (and thus the assume) actually runs.
    for await (const _evt of result.stream) void _evt;
    expect(capturedScope?.s3Keys).toEqual([
      { bucket: "stk-files-1", key: "shared/image/ab/cd/pic.jpg" },
    ]);
  });
});

const streamInvoker: BedrockInvoker = {
  async converse() {
    throw new Error("not used");
  },
  async *converseStream() {
    yield { type: "text", text: "a cat " };
    yield { type: "text", text: "on a mat" };
    yield { type: "done", inputTokens: 1200, outputTokens: 8 };
  },
};

describe("capability handler — streaming", () => {
  it("yields text chunks then a done event and reconciles the ledger to actuals", async () => {
    const db = new InMemoryCapabilityDb({ models: ["anthropic.claude-haiku-4-5"], reports: [] }, []);
    const result = await handleCapabilityInvokeStream(baseDeps(db, { invoker: streamInvoker }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an open stream");

    const events = [];
    for await (const evt of result.stream) events.push(evt);
    const text = events.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.text : "")).join("");
    expect(text).toBe("a cat on a mat");
    const done = events.find((e) => e.type === "done");
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.usage.outputTokens).toBe(8);
      // cost re-derived from actual tokens (1200*$1/MTok + 8*$5/MTok)
      expect(done.estCostUsd).toBeCloseTo((1200 * 1) / 1e6 + (8 * 5) / 1e6);
    }
    // Reserved rows promoted to committed actuals on stream completion.
    const committed = db.ledger.filter((r) => r.status === "committed");
    expect(committed.some((r) => r.dimension === "output" && r.unit === "tokens" && r.quantity === 8)).toBe(true);
  });

  it("rejects pre-stream (not_granted 403) without opening a stream", async () => {
    const db = new InMemoryCapabilityDb(null, []);
    const result = await handleCapabilityInvokeStream(baseDeps(db, { invoker: streamInvoker }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.statusCode).toBe(403);
  });

  it("rejects pre-stream on a gate breach (429) and releases the reservation", async () => {
    // A tiny output-token gate the worst-case reservation (maxTokens) breaches.
    const db = new InMemoryCapabilityDb(
      { models: ["anthropic.claude-haiku-4-5"], reports: [] },
      [{ dimension: "output", unit: "tokens", limit_value: 1 }],
    );
    const result = await handleCapabilityInvokeStream(baseDeps(db, { invoker: streamInvoker }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.statusCode).toBe(429);
    expect(db.ledger.every((r) => r.status === "released")).toBe(true);
  });

  it("releases the reservation and emits an error event when the stream throws", async () => {
    const db = new InMemoryCapabilityDb({ models: ["anthropic.claude-haiku-4-5"], reports: [] }, []);
    const result = await handleCapabilityInvokeStream(
      baseDeps(db, {
        invoker: {
          async converse() {
            throw new Error("not used");
          },
          // eslint-disable-next-line require-yield
          async *converseStream() {
            throw new Error("bedrock stream exploded");
          },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an open stream");
    const events = [];
    for await (const evt of result.stream) events.push(evt);
    const err = events.find((e) => e.type === "error");
    expect(err?.type).toBe("error");
    expect(db.ledger.every((r) => r.status === "released")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sync-s3 (image) output — Nova Canvas, plan §3.8
// ---------------------------------------------------------------------------

const IMAGE_MODEL = "amazon.nova-canvas-v1:0";

/** A fake sync image generator returning fixed PNG bytes, capturing the request. */
function fakeImageInvoker(
  onReq?: (r: BedrockImageGenRequest) => void,
  images: Uint8Array[] = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])],
): BedrockImageInvoker {
  return {
    async generateImage(req) {
      onReq?.(req);
      return { images, format: "png" };
    },
  };
}

/** Deps for a prompt-only image-generation request (no contentRef). Captures
 * what the CDS wrote via writeSyncOutput. */
function imageDeps(
  db: InMemoryCapabilityDb,
  written: { calls: { invocationId: string; images: Uint8Array[]; contentType: string }[] },
  over: Partial<CapabilityHandlerDeps> = {},
): CapabilityHandlerDeps {
  return {
    appId: "photos",
    capabilityName: "bedrock.invoke",
    body: { model: IMAGE_MODEL, prompt: "a watercolor cat" },
    capClient: db,
    assumeCapabilityCreds: async () => ({ accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" }),
    invoker: fakeInvoker,
    imageInvoker: fakeImageInvoker(),
    writeSyncOutput: async (invocationId, images, contentType): Promise<SyncImageOutput> => {
      written.calls.push({ invocationId, images, contentType });
      const total = images.reduce((n, im) => n + im.byteLength, 0);
      return {
        bucket: "stk-files-1",
        keyPrefix: `apps/photos/syncable/capability-image/${invocationId}`,
        keys: images.map((_, i) => `apps/photos/syncable/capability-image/${invocationId}/image-${i}.png`),
        totalBytes: total,
      };
    },
    region: "us-east-1",
    timeZone: "UTC",
    ...over,
  };
}

describe("capability handler — sync-s3 image output (plan §3.8)", () => {
  it("generates, writes the bytes under the app role, and returns the output key(s) + derived cost", async () => {
    const db = new InMemoryCapabilityDb({ models: [IMAGE_MODEL], reports: [] }, []);
    const written = { calls: [] as { invocationId: string; images: Uint8Array[]; contentType: string }[] };
    const res = await handleCapabilityInvoke(imageDeps(db, written));

    expect(res.statusCode).toBe(200);
    const body = res.body as {
      model: string;
      output: { bucket: string; keyPrefix: string; keys: string[]; totalBytes: number };
      usage: { inputTokens: number; outputTokens: number };
      estCostUsd: number;
      invocationId: string;
    };
    // The CDS wrote exactly one image to the app's syncable area (not inlined).
    expect(written.calls).toHaveLength(1);
    expect(written.calls[0]!.contentType).toBe("image/png");
    expect(body.output.keys).toHaveLength(1);
    expect(body.output.keys[0]).toContain("apps/photos/syncable/capability-image/");
    // No tokens for image gen; cost is CDS-derived per image (requests:image $0.04).
    expect(body.usage.outputTokens).toBe(0);
    expect(body.estCostUsd).toBeCloseTo(0.04, 5);

    // Ledger: a committed cost row equal to the per-image price, a committed
    // requests:image, and a committed output:bytes measured from the write.
    const committed = db.ledger.filter((r) => r.status === "committed");
    const cost = committed.find((r) => r.dimension === "cost" && r.unit === "usd");
    expect(cost?.quantity).toBeCloseTo(0.04, 5);
    expect(committed.some((r) => r.dimension === "requests" && r.unit === "image")).toBe(true);
    const outBytes = committed.find((r) => r.dimension === "output" && r.unit === "bytes");
    expect(outBytes?.quantity).toBe(written.calls[0]!.images[0]!.byteLength);
    // No reservation left dangling.
    expect(db.ledger.some((r) => r.status === "reserved")).toBe(false);
  });

  it("passes the prompt + generation params to the image invoker", async () => {
    const db = new InMemoryCapabilityDb({ models: [IMAGE_MODEL], reports: [] }, []);
    let captured: BedrockImageGenRequest | undefined;
    const written = { calls: [] as { invocationId: string; images: Uint8Array[]; contentType: string }[] };
    const res = await handleCapabilityInvoke(
      imageDeps(db, written, {
        body: { model: IMAGE_MODEL, prompt: "a red bicycle", generation: { width: 512, height: 512, seed: 7 } },
        imageInvoker: fakeImageInvoker((r) => (captured = r)),
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(captured?.prompt).toBe("a red bicycle");
    expect(captured?.generation).toMatchObject({ width: 512, height: 512, seed: 7 });
    expect(captured?.provider).toBe("amazon");
  });

  it("denies (429) on a cost gate BEFORE generating, and releases the reservation", async () => {
    // A cost gate below the per-image price is breached by the reservation.
    const db = new InMemoryCapabilityDb(
      { models: [IMAGE_MODEL], reports: [] },
      [{ dimension: "cost", unit: "usd", limit_value: 0.01 }],
    );
    let generated = false;
    const written = { calls: [] as { invocationId: string; images: Uint8Array[]; contentType: string }[] };
    const res = await handleCapabilityInvoke(
      imageDeps(db, written, {
        imageInvoker: fakeImageInvoker(() => (generated = true)),
      }),
    );
    expect(res.statusCode).toBe(429);
    expect(generated).toBe(false);
    expect(written.calls).toHaveLength(0);
    expect(db.ledger.every((r) => r.status === "released")).toBe(true);
  });

  it("releases the reservation and 502s when the image invoker throws (nothing written)", async () => {
    const db = new InMemoryCapabilityDb({ models: [IMAGE_MODEL], reports: [] }, []);
    const written = { calls: [] as { invocationId: string; images: Uint8Array[]; contentType: string }[] };
    const res = await handleCapabilityInvoke(
      imageDeps(db, written, {
        imageInvoker: {
          async generateImage() {
            throw new Error("canvas exploded");
          },
        },
      }),
    );
    expect(res.statusCode).toBe(502);
    expect(written.calls).toHaveLength(0);
    expect(db.ledger.every((r) => r.status === "released")).toBe(true);
  });

  it("500s (releasing the reservation) if the image deps are not wired", async () => {
    const db = new InMemoryCapabilityDb({ models: [IMAGE_MODEL], reports: [] }, []);
    const written = { calls: [] as { invocationId: string; images: Uint8Array[]; contentType: string }[] };
    const deps = imageDeps(db, written);
    delete (deps as Partial<CapabilityHandlerDeps>).imageInvoker;
    delete (deps as Partial<CapabilityHandlerDeps>).writeSyncOutput;
    const res = await handleCapabilityInvoke(deps);
    expect(res.statusCode).toBe(500);
    expect(db.ledger.every((r) => r.status === "released")).toBe(true);
  });

  it("rejects an image (sync-s3) model on the streaming route — not streamable", async () => {
    const db = new InMemoryCapabilityDb({ models: [IMAGE_MODEL], reports: [] }, []);
    const written = { calls: [] as { invocationId: string; images: Uint8Array[]; contentType: string }[] };
    const res = await handleCapabilityInvokeStream(imageDeps(db, written));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected a rejection");
    expect(res.response.statusCode).toBe(400);
    expect((res.response.body as { error: string }).error).toBe("output_not_streamable");
    // The pre-flight reservation was released, not stranded.
    expect(db.ledger.every((r) => r.status === "released")).toBe(true);
  });
});

describe("buildImageModelInput (Nova Canvas body)", () => {
  it("builds a TEXT_IMAGE body with one image at the requested size", () => {
    const body = buildImageModelInput({
      target: "amazon.nova-canvas-v1:0",
      region: "us-east-1",
      provider: "amazon",
      prompt: "a watercolor cat",
      generation: { width: 512, height: 512, seed: 7 },
      credentials: { accessKeyId: "A", secretAccessKey: "S", sessionToken: "T" },
    }) as {
      taskType: string;
      textToImageParams: { text: string };
      imageGenerationConfig: { numberOfImages: number; width: number; height: number; seed: number };
    };
    expect(body.taskType).toBe("TEXT_IMAGE");
    expect(body.textToImageParams.text).toBe("a watercolor cat");
    // numberOfImages is capped at 1 for this increment (plan §3.8).
    expect(body.imageGenerationConfig.numberOfImages).toBe(1);
    expect(body.imageGenerationConfig.width).toBe(512);
    expect(body.imageGenerationConfig.seed).toBe(7);
  });

  it("throws for a provider without a sync-image adapter", () => {
    expect(() =>
      buildImageModelInput({
        target: "anthropic.x",
        region: "us-east-1",
        provider: "anthropic",
        prompt: "x",
        credentials: { accessKeyId: "A", secretAccessKey: "S", sessionToken: "T" },
      }),
    ).toThrow(/not supported/);
  });
});
