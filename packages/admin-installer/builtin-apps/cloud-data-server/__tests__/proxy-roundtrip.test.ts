/**
 * Cross-package signing contract: the @starkeep/app-client PROXY (what the
 * browser-facing apps forward through) produces signatures the cloud data
 * server's real verifier accepts.
 *
 * handler-auth.test.ts already round-trips `signRequest` (the primitive)
 * against `validateAppHmac`. This closes the remaining seam that the reinstall
 * failure exposed: it's `proxyToDataServer` — not raw `signRequest` — that
 * signs real browser traffic, and the app was 401'ing because that proxy path
 * wasn't being used at all. Here we drive the proxy for the exact requests the
 * app makes (notably the `GET /data/records?limit=500` that failed) and assert
 * the verifier says ok, so a future signing/canonicalization drift in the proxy
 * is caught against the authoritative verifier.
 */
import { describe, expect, it, vi } from "vitest";
import { proxyToDataServer } from "@starkeep/app-client";
import { validateAppHmac } from "../src/api-handler.js";

const APP_ID = "photos";
const SECRET = "roundtrip-secret";
const DATA_SERVER_URL = "http://data-server.test/apps/photos";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Buffer | string;
}

/** Run a request through the proxy and capture what it sent on the wire. */
async function signViaProxy(method: string, path: string, body?: Buffer | string): Promise<CapturedRequest> {
  let captured: CapturedRequest | null = null;
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    captured = {
      url: String(url),
      method: (init?.method ?? "GET").toUpperCase(),
      headers: init?.headers as Record<string, string>,
      body: init?.body as Buffer | string | undefined,
    };
    return new Response(null, { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  try {
    await proxyToDataServer(
      { appId: APP_ID, hmacSecret: SECRET, dataServerUrl: DATA_SERVER_URL },
      { method, path, headers: {}, body },
    );
  } finally {
    vi.unstubAllGlobals();
  }
  if (captured === null) throw new Error("proxy did not issue a fetch");
  return captured as CapturedRequest;
}

/** Lower-cased header map, matching what API Gateway hands the handler. */
function normalizeHeaders(headers: Record<string, string>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

describe("proxy → cloud-data-server HMAC verifier round-trip", () => {
  it("accepts the GET /data/records?limit=500 that originally 401'd", async () => {
    const sent = await signViaProxy("GET", "/data/records?limit=500");

    expect(sent.url).toBe(`${DATA_SERVER_URL}/data/records?limit=500`);

    // API Gateway routes on a query-free subPath; the verifier canonicalizes
    // both sides, so pass the path with the query and expect it to still match.
    const result = validateAppHmac(
      APP_ID,
      "GET",
      "/data/records",
      normalizeHeaders(sent.headers),
      Buffer.alloc(0),
      SECRET,
    );
    expect(result).toEqual({ ok: true });
  });

  it("accepts a POST /data/records with a JSON body", async () => {
    const body = JSON.stringify({ type: "image/png", contentHash: "abc", sizeBytes: 3 });
    const sent = await signViaProxy("POST", "/data/records", body);

    const result = validateAppHmac(
      APP_ID,
      "POST",
      "/data/records",
      normalizeHeaders(sent.headers),
      Buffer.from(body, "utf8"),
      SECRET,
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects when the body is tampered after signing", async () => {
    const sent = await signViaProxy("POST", "/data/records", JSON.stringify({ ok: true }));

    const result = validateAppHmac(
      APP_ID,
      "POST",
      "/data/records",
      normalizeHeaders(sent.headers),
      Buffer.from(JSON.stringify({ ok: false }), "utf8"), // different bytes
      SECRET,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects when the path is tampered after signing", async () => {
    const sent = await signViaProxy("GET", "/data/records?limit=500");

    const result = validateAppHmac(
      APP_ID,
      "GET",
      "/data/records/secret", // signed for /data/records
      normalizeHeaders(sent.headers),
      Buffer.alloc(0),
      SECRET,
    );
    expect(result.ok).toBe(false);
  });
});
