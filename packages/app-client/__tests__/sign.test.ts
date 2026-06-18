import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { signRequest, signedFetch, canonicalSignedPath } from "../src/sign.js";
import type { AppCredentials } from "../src/credentials.js";

/**
 * Reference implementation of the server's verifier computation, mirrored
 * byte-for-byte from `apps/local-data-server/server.ts` `validateAppHmac`
 * (and the cloud broker's equivalent): hmac-sha256(secret,
 * utf8("<appId>:<METHOD>:<path>:<ts>:") ++ raw body bytes), hex digest. The
 * signature binds method + path + timestamp; this is the single most
 * regression-prone constant in the app ecosystem — if either side changes
 * shape, this suite must fail.
 */
function serverExpectedSig(
  secret: string,
  appId: string,
  method: string,
  path: string,
  ts: number,
  body: Buffer,
): string {
  const prefix = Buffer.from(
    `${appId}:${method.toUpperCase()}:${canonicalSignedPath(path)}:${ts}:`,
    "utf8",
  );
  const input = Buffer.concat([prefix as unknown as Uint8Array, body as unknown as Uint8Array]);
  return createHmac("sha256", secret).update(input as unknown as Uint8Array).digest("hex");
}

const creds: AppCredentials = {
  appId: "photos",
  hmacSecret: "super-secret",
  dataServerUrl: "http://127.0.0.1:9820",
};

const TS = 1_700_000_000_000;

describe("signRequest matches the server's validateAppHmac formula", () => {
  it("emits a timestamp header and binds it into the signature", () => {
    const headers = signRequest({
      appId: "photos",
      hmacSecret: "super-secret",
      method: "GET",
      path: "/data/records",
      timestamp: TS,
    });
    expect(headers["X-Starkeep-App-Id"]).toBe("photos");
    expect(headers["X-Starkeep-App-Ts"]).toBe(String(TS));
    expect(headers["X-Starkeep-App-Sig"]).toBe(
      serverExpectedSig("super-secret", "photos", "GET", "/data/records", TS, Buffer.alloc(0)),
    );
  });

  it("defaults the timestamp to now when unspecified", () => {
    const before = Date.now();
    const headers = signRequest({
      appId: "photos",
      hmacSecret: "super-secret",
      method: "GET",
      path: "/x",
    });
    const ts = Number(headers["X-Starkeep-App-Ts"]);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });

  it("signs a string body over its utf-8 bytes", () => {
    const body = JSON.stringify({ hello: "wörld" });
    const headers = signRequest({
      appId: "photos",
      hmacSecret: "super-secret",
      method: "POST",
      path: "/data/records",
      body,
      timestamp: TS,
    });
    expect(headers["X-Starkeep-App-Sig"]).toBe(
      serverExpectedSig("super-secret", "photos", "POST", "/data/records", TS, Buffer.from(body, "utf8")),
    );
  });

  it("signs binary bodies losslessly (bytes that are not valid utf-8)", () => {
    const body = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41]);
    const headers = signRequest({
      appId: "photos",
      hmacSecret: "super-secret",
      method: "POST",
      path: "/p",
      body,
      timestamp: TS,
    });
    expect(headers["X-Starkeep-App-Sig"]).toBe(
      serverExpectedSig("super-secret", "photos", "POST", "/p", TS, body),
    );
  });

  it("signs Uint8Array bodies identically to Buffer bodies", () => {
    const bytes = new Uint8Array([1, 2, 3, 250]);
    const common = { appId: "a", hmacSecret: "s", method: "POST", path: "/p", timestamp: TS };
    const fromU8 = signRequest({ ...common, body: bytes });
    const fromBuf = signRequest({ ...common, body: Buffer.from(bytes) });
    expect(fromU8["X-Starkeep-App-Sig"]).toBe(fromBuf["X-Starkeep-App-Sig"]);
  });

  it("binds the signature to the app id", () => {
    const common = { hmacSecret: "s", method: "POST", path: "/p", body: "x", timestamp: TS };
    const a = signRequest({ ...common, appId: "photos" });
    const b = signRequest({ ...common, appId: "drive" });
    expect(a["X-Starkeep-App-Sig"]).not.toBe(b["X-Starkeep-App-Sig"]);
  });

  it("binds the signature to the method", () => {
    const common = { appId: "photos", hmacSecret: "s", path: "/p", body: "x", timestamp: TS };
    const post = signRequest({ ...common, method: "POST" });
    const put = signRequest({ ...common, method: "PUT" });
    expect(post["X-Starkeep-App-Sig"]).not.toBe(put["X-Starkeep-App-Sig"]);
  });

  it("binds the signature to the path", () => {
    const common = { appId: "photos", hmacSecret: "s", method: "POST", body: "x", timestamp: TS };
    const a = signRequest({ ...common, path: "/data/records" });
    const b = signRequest({ ...common, path: "/data/files" });
    expect(a["X-Starkeep-App-Sig"]).not.toBe(b["X-Starkeep-App-Sig"]);
  });

  it("binds the signature to the timestamp", () => {
    const common = { appId: "photos", hmacSecret: "s", method: "POST", path: "/p", body: "x" };
    const a = signRequest({ ...common, timestamp: TS });
    const b = signRequest({ ...common, timestamp: TS + 1 });
    expect(a["X-Starkeep-App-Sig"]).not.toBe(b["X-Starkeep-App-Sig"]);
  });
});

describe("canonicalSignedPath", () => {
  it("strips the query string", () => {
    expect(canonicalSignedPath("/data/records?type=jpg&limit=5")).toBe("/data/records");
  });
  it("percent-decodes so encoded and decoded forms agree", () => {
    expect(canonicalSignedPath("/files/shared%2Fimage%2Fab%2Fcd")).toBe("/files/shared/image/ab/cd");
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
    const ts = Number(headers["X-Starkeep-App-Ts"]);
    expect(headers["X-Starkeep-App-Sig"]).toBe(
      serverExpectedSig("super-secret", "photos", "GET", "/data/records", ts, Buffer.alloc(0)),
    );
  });

  it("signs the body and path on POST", async () => {
    const calls = captureFetch();
    const body = JSON.stringify({ a: 1 });
    await signedFetch(creds, "/data/records", { method: "POST", body });
    const headers = calls[0].init.headers as Record<string, string>;
    const ts = Number(headers["X-Starkeep-App-Ts"]);
    expect(headers["X-Starkeep-App-Sig"]).toBe(
      serverExpectedSig("super-secret", "photos", "POST", "/data/records", ts, Buffer.from(body, "utf8")),
    );
    expect(calls[0].init.body).toBe(body);
  });

  it("drops the body and signs empty for GET/HEAD", async () => {
    const calls = captureFetch();
    await signedFetch(creds, "/data/records", { method: "get", body: "ignored" });
    const headers = calls[0].init.headers as Record<string, string>;
    const ts = Number(headers["X-Starkeep-App-Ts"]);
    expect(headers["X-Starkeep-App-Sig"]).toBe(
      serverExpectedSig("super-secret", "photos", "GET", "/data/records", ts, Buffer.alloc(0)),
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
