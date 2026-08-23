/**
 * The proxy's end-user gate. The property under test is narrow and important:
 * a request that fails the session check must be refused *before* the app's
 * HMAC credential is loaded, so a rejected caller cannot cause the secret to
 * be read at all — let alone used to sign an upstream request.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNextProxyHandler,
  clearAppCredentialsCache,
  sessionAuth,
  type MinimalNextRequest,
} from "../src/index.js";

const proxyMock = vi.hoisted(() => ({ proxyToDataServer: vi.fn() }));
vi.mock("../src/proxy.js", () => proxyMock);
vi.mock("../src/proxy", () => proxyMock);

let dir: string;
const savedMode = process.env.STARKEEP_APP_CLIENT_MODE;
const savedDir = process.env.STARKEEP_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "app-client-proxy-auth-"));
  process.env.STARKEEP_DIR = dir;
  delete process.env.STARKEEP_APP_CLIENT_MODE;
  clearAppCredentialsCache();
  proxyMock.proxyToDataServer.mockReset();
  proxyMock.proxyToDataServer.mockResolvedValue({
    status: 200,
    headers: { "content-type": "application/json" },
    body: '{"ok":true}',
  });
  // A real local creds file, so "the credential was never loaded" is a claim
  // about the gate and not about a missing file.
  mkdirSync(join(dir, "app-creds"), { recursive: true });
  writeFileSync(
    join(dir, "app-creds", "testapp.json"),
    JSON.stringify({ appId: "testapp", hmacSecret: "s3cret", dataServerUrl: "http://127.0.0.1:9820" }),
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedMode === undefined) delete process.env.STARKEEP_APP_CLIENT_MODE;
  else process.env.STARKEEP_APP_CLIENT_MODE = savedMode;
  if (savedDir === undefined) delete process.env.STARKEEP_DIR;
  else process.env.STARKEEP_DIR = savedDir;
});

function request(headers: Record<string, string> = {}): MinimalNextRequest {
  return {
    method: "GET",
    url: "http://localhost:3000/api/data/data/records?limit=5",
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => "",
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

const ctx = { params: Promise.resolve({ path: ["data", "records"] }) };

describe("endUserAuth: session", () => {
  it("refuses an unauthenticated cloud request with 401 and never signs", async () => {
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
    process.env.STARKEEP_CLOUD_DATA_BASE = "https://gateway.example.com";
    const handler = createNextProxyHandler({
      appId: "testapp",
      endUserAuth: { auth: "session", verifySession: () => false },
    });

    const res = await handler(request(), ctx);

    expect(res.status).toBe(401);
    expect(proxyMock.proxyToDataServer).not.toHaveBeenCalled();
  });

  it("forwards a request whose session verifies", async () => {
    // Local mode with the exemption off: the gate runs, and the credential
    // comes from the local file rather than SSM, so the assertion is about the
    // gate and not about the credential source.
    const verifySession = vi.fn().mockResolvedValue(true);
    const handler = createNextProxyHandler({
      appId: "testapp",
      endUserAuth: { auth: "session", verifySession, allowAnonymousLocal: false },
    });

    const res = await handler(request({ cookie: "sk_session=abc" }), ctx);

    expect(verifySession).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    expect(proxyMock.proxyToDataServer).toHaveBeenCalledOnce();
  });

  it("does not gate local mode by default — local-first means no sign-in in front of on-device data", async () => {
    const verifySession = vi.fn().mockReturnValue(false);
    const handler = createNextProxyHandler({
      appId: "testapp",
      endUserAuth: { auth: "session", verifySession },
    });

    const res = await handler(request(), ctx);

    expect(verifySession).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("gates local mode too when allowAnonymousLocal is false", async () => {
    const handler = createNextProxyHandler({
      appId: "testapp",
      endUserAuth: { auth: "session", verifySession: () => false, allowAnonymousLocal: false },
    });

    const res = await handler(request(), ctx);

    expect(res.status).toBe(401);
    expect(proxyMock.proxyToDataServer).not.toHaveBeenCalled();
  });

  it("uses onUnauthenticated when supplied", async () => {
    const handler = createNextProxyHandler({
      appId: "testapp",
      endUserAuth: { auth: "session", verifySession: () => false, allowAnonymousLocal: false },
      onUnauthenticated: () => new Response(null, { status: 302, headers: { location: "/sign-in" } }),
    });

    const res = await handler(request(), ctx);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/sign-in");
  });
});

describe("endUserAuth: anonymous", () => {
  it("forwards without any end-user check", async () => {
    const handler = createNextProxyHandler({
      appId: "testapp",
      endUserAuth: { auth: "anonymous", justification: "test fixture" },
    });

    const res = await handler(request(), ctx);

    expect(res.status).toBe(200);
    expect(proxyMock.proxyToDataServer).toHaveBeenCalledOnce();
  });
});

describe("sessionAuth()", () => {
  it("refuses an unauthenticated cloud request with 401 and never signs", async () => {
    // The zero-argument form is the one apps are told to use, so the property
    // the explicit form is tested for above has to hold for it too — and it is
    // the form whose verifier the app did not write and cannot inspect.
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
    process.env.STARKEEP_CLOUD_DATA_BASE = "https://gateway.example.com";
    const handler = createNextProxyHandler({ appId: "testapp", endUserAuth: sessionAuth() });

    const res = await handler(request(), ctx);

    expect(res.status).toBe(401);
    expect(proxyMock.proxyToDataServer).not.toHaveBeenCalled();
  });

  it("leaves local mode open by default", async () => {
    const handler = createNextProxyHandler({ appId: "testapp", endUserAuth: sessionAuth() });
    expect((await handler(request(), ctx)).status).toBe(200);
  });

  it("gates local mode when the app opts in", async () => {
    const handler = createNextProxyHandler({
      appId: "testapp",
      endUserAuth: sessionAuth({ allowAnonymousLocal: false }),
    });
    expect((await handler(request(), ctx)).status).toBe(401);
    expect(proxyMock.proxyToDataServer).not.toHaveBeenCalled();
  });
});
