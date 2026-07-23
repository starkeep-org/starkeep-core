import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  invokeCapability,
  getGrantedCapabilities,
  CapabilityUnavailableError,
  clearAppCredentialsCache,
} from "../src/index.js";

let dir: string;
const APP_ID = "photos";
let fetchMock: ReturnType<typeof vi.fn>;

function writeCreds(over: Record<string, unknown> = {}): void {
  const credsDir = join(dir, "app-creds");
  mkdirSync(credsDir, { recursive: true });
  writeFileSync(
    join(credsDir, `${APP_ID}.json`),
    JSON.stringify({ appId: APP_ID, hmacSecret: "s".repeat(32), dataServerUrl: "http://127.0.0.1:9820", ...over }),
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "capability-test-"));
  process.env.STARKEEP_DIR = dir;
  process.env.STARKEEP_CLOUD_DATA_BASE = "https://cloud.example.test";
  delete process.env.STARKEEP_APP_CLIENT_MODE;
  clearAppCredentialsCache();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  delete process.env.STARKEEP_CLOUD_DATA_BASE;
  clearAppCredentialsCache();
});

describe("invokeCapability", () => {
  it("posts to the cloud capability route with the app's credentials and returns the result", async () => {
    writeCreds();
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        model: "anthropic.claude-haiku-4-5",
        text: "a dog",
        usage: { inputTokens: 100, outputTokens: 5 },
        estCostUsd: 0.000125,
        invocationId: "inv1",
      }),
    );
    const res = await invokeCapability(APP_ID, "bedrock.invoke", {
      model: "anthropic.claude-haiku-4-5",
      prompt: "caption",
      contentRef: { recordId: "rec1" },
    });
    expect(res.granted).toBe(true);
    if (res.granted && res.ok) {
      expect(res.text).toBe("a dog");
      expect(res.invocationId).toBe("inv1");
    } else {
      throw new Error("expected success");
    }
    // Hit the CLOUD base (not the local data server URL), under /apps/<appId>.
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe("https://cloud.example.test/apps/photos/capabilities/bedrock.invoke/invoke");
    // HMAC headers present.
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string>; method: string };
    expect(init.method).toBe("POST");
    expect(init.headers["X-Starkeep-App-Id"]).toBe(APP_ID);
    expect(init.headers["X-Starkeep-App-Sig"]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns { granted: false } on a not_granted 403 (degraded mode, no throw)", async () => {
    writeCreds();
    fetchMock.mockResolvedValue(jsonResponse(403, { error: "not_granted" }));
    const res = await invokeCapability(APP_ID, "bedrock.invoke", { model: "m", prompt: "p" });
    expect(res).toEqual({ granted: false });
  });

  it("surfaces a gate 429 as a structured failure, still granted", async () => {
    writeCreds();
    fetchMock.mockResolvedValue(jsonResponse(429, { error: "gate_exceeded", breaches: [] }));
    const res = await invokeCapability(APP_ID, "bedrock.invoke", { model: "m", prompt: "p" });
    expect(res.granted).toBe(true);
    if (res.granted && !res.ok) {
      expect(res.status).toBe(429);
      expect(res.error).toBe("gate_exceeded");
    } else {
      throw new Error("expected failure");
    }
  });

  it("throws CapabilityUnavailableError when no cloud plane is configured", async () => {
    writeCreds();
    delete process.env.STARKEEP_CLOUD_DATA_BASE;
    clearAppCredentialsCache();
    await expect(
      invokeCapability(APP_ID, "bedrock.invoke", { model: "m", prompt: "p" }),
    ).rejects.toBeInstanceOf(CapabilityUnavailableError);
  });

  it("accepts the app's own dataServerUrl when it is already a cloud https endpoint", async () => {
    delete process.env.STARKEEP_CLOUD_DATA_BASE;
    writeCreds({ dataServerUrl: "https://cloud.example.test/apps/photos" });
    clearAppCredentialsCache();
    fetchMock.mockResolvedValue(jsonResponse(200, { text: "ok", usage: {}, model: "m" }));
    const res = await invokeCapability(APP_ID, "bedrock.invoke", { model: "m", prompt: "p" });
    expect(res.granted).toBe(true);
  });
});

describe("getGrantedCapabilities", () => {
  it("lists grants; returns [] with no cloud plane instead of throwing", async () => {
    writeCreds();
    fetchMock.mockResolvedValue(
      jsonResponse(200, { capabilities: [{ name: "bedrock.invoke", models: ["m"], reports: [] }] }),
    );
    const caps = await getGrantedCapabilities(APP_ID);
    expect(caps).toEqual([{ name: "bedrock.invoke", models: ["m"], reports: [] }]);

    delete process.env.STARKEEP_CLOUD_DATA_BASE;
    clearAppCredentialsCache();
    expect(await getGrantedCapabilities(APP_ID)).toEqual([]);
  });
});
