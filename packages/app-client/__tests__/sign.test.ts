import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { signRequest, signedFetch } from "../src/sign.js";
import type { AppCredentials } from "../src/credentials.js";

/**
 * Reference implementation of the server's verifier computation, mirrored
 * byte-for-byte from `apps/local-data-server/server.ts` `validateAppHmac`
 * (and the cloud broker's equivalent): hmac-sha256(secret, utf8("<appId>:")
 * ++ raw body bytes), hex digest. This is the single most regression-prone
 * constant in the app ecosystem — if either side changes shape, this suite
 * must fail.
 */
function serverExpectedSig(secret: string, appId: string, body: Buffer): string {
  const prefix = Buffer.from(`${appId}:`, "utf8");
  const input = Buffer.concat([prefix as unknown as Uint8Array, body as unknown as Uint8Array]);
  return createHmac("sha256", secret).update(input as unknown as Uint8Array).digest("hex");
}

const creds: AppCredentials = {
  appId: "photos",
  hmacSecret: "super-secret",
  dataServerUrl: "http://127.0.0.1:9820",
};

describe("signRequest matches the server's validateAppHmac formula", () => {
  it("signs an undefined body as the empty body", () => {
    const headers = signRequest({ appId: "photos", hmacSecret: "super-secret" });
    expect(headers["X-Starkeep-App-Id"]).toBe("photos");
    expect(headers["X-Starkeep-App-Sig"]).toBe(
      serverExpectedSig("super-secret", "photos", Buffer.alloc(0)),
    );
  });

  it("signs a string body over its utf-8 bytes", () => {
    const body = JSON.stringify({ hello: "wörld" });
    const headers = signRequest({ appId: "photos", hmacSecret: "super-secret", body });
    expect(headers["X-Starkeep-App-Sig"]).toBe(
      serverExpectedSig("super-secret", "photos", Buffer.from(body, "utf8")),
    );
  });

  it("signs binary bodies losslessly (bytes that are not valid utf-8)", () => {
    const body = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41]);
    const headers = signRequest({ appId: "photos", hmacSecret: "super-secret", body });
    expect(headers["X-Starkeep-App-Sig"]).toBe(serverExpectedSig("super-secret", "photos", body));
  });

  it("signs Uint8Array bodies identically to Buffer bodies", () => {
    const bytes = new Uint8Array([1, 2, 3, 250]);
    const fromU8 = signRequest({ appId: "a", hmacSecret: "s", body: bytes });
    const fromBuf = signRequest({ appId: "a", hmacSecret: "s", body: Buffer.from(bytes) });
    expect(fromU8["X-Starkeep-App-Sig"]).toBe(fromBuf["X-Starkeep-App-Sig"]);
  });

  it("binds the signature to the app id", () => {
    const a = signRequest({ appId: "photos", hmacSecret: "s", body: "x" });
    const b = signRequest({ appId: "drive", hmacSecret: "s", body: "x" });
    expect(a["X-Starkeep-App-Sig"]).not.toBe(b["X-Starkeep-App-Sig"]);
  });
});

describe("signedFetch", () => {
  afterEach(() => vi.unstubAllGlobals());

  function captureFetch() {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response("{}"));
    });
    return calls;
  }

  it("prefixes the data-server URL and attaches signed headers", async () => {
    const calls = captureFetch();
    await signedFetch(creds, "/data/records");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:9820/data/records");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["X-Starkeep-App-Id"]).toBe("photos");
    expect(headers["X-Starkeep-App-Sig"]).toBe(
      serverExpectedSig("super-secret", "photos", Buffer.alloc(0)),
    );
  });

  it("signs the body on POST", async () => {
    const calls = captureFetch();
    const body = JSON.stringify({ a: 1 });
    await signedFetch(creds, "/data/records", { method: "POST", body });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["X-Starkeep-App-Sig"]).toBe(
      serverExpectedSig("super-secret", "photos", Buffer.from(body, "utf8")),
    );
    expect(calls[0].init.body).toBe(body);
  });

  it("drops the body and signs empty for GET/HEAD", async () => {
    const calls = captureFetch();
    await signedFetch(creds, "/data/records", { method: "get", body: "ignored" });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["X-Starkeep-App-Sig"]).toBe(
      serverExpectedSig("super-secret", "photos", Buffer.alloc(0)),
    );
    expect(calls[0].init.body).toBeUndefined();
  });

  it("preserves caller headers", async () => {
    const calls = captureFetch();
    await signedFetch(creds, "/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });
});
