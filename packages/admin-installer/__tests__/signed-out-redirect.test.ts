/**
 * The CloudFront viewer-request redirect.
 *
 * It enforces nothing — the API Gateway origin stays directly reachable and
 * anyone who wants to skip this can. What it buys is that a crawler, a
 * scanner, or a signed-out person clicking a bookmark does not spend a Lambda
 * invocation to be told to sign in. Against an account concurrency limit of
 * ten, that is the difference between a slow page and five 503s.
 *
 * The exclusions are the part worth testing, because each one is a way to
 * break something real rather than a preference. The function source is
 * extracted from the Pulumi program and evaluated here, so what runs in these
 * assertions is the string that gets deployed — a hand-copied duplicate would
 * pass while the deployed one was broken.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface CfHeader {
  value: string;
}
interface CfRequest {
  uri: string;
  headers: Record<string, CfHeader>;
}
interface CfResponse {
  statusCode?: number;
  headers?: Record<string, CfHeader>;
}

function loadDeployedFunction(): (event: { request: CfRequest }) => CfRequest | CfResponse {
  const program = readFileSync(
    resolve(PKG_DIR, "src", "builtin-programs", "cloud-data-server-program.ts"),
    "utf-8",
  );
  const match = program.match(/code: `(function handler[\s\S]*?)`,\n\s*\}\);/);
  if (!match) throw new Error("could not find the viewer-request function source");
  // The source sits in a TS template literal, so backslashes are doubled and
  // backticks/`${` are escaped. Undo exactly that.
  const code = match[1]!.replace(/\\\\/g, "\\").replace(/\\`/g, "`").replace(/\\\$/g, "$");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${code}; return handler;`)() as ReturnType<typeof loadDeployedFunction>;
}

const handler = loadDeployedFunction();

function req(uri: string, opts: { dest?: string; cookie?: string } = {}): CfRequest {
  const headers: Record<string, CfHeader> = {};
  if (opts.dest) headers["sec-fetch-dest"] = { value: opts.dest };
  if (opts.cookie) headers.cookie = { value: opts.cookie };
  return { uri, headers };
}

function isRedirect(result: CfRequest | CfResponse): result is CfResponse {
  return "statusCode" in result;
}

describe("redirects", () => {
  it("an anonymous document load of an app page", () => {
    const res = handler({ request: req("/apps/memo/browse", { dest: "document" }) });
    expect(isRedirect(res)).toBe(true);
    expect((res as CfResponse).statusCode).toBe(302);
    expect((res as CfResponse).headers!.location.value).toBe("/apps/memo/sign-in");
  });

  it("to the right app's sign-in page", () => {
    const res = handler({ request: req("/apps/photos/", { dest: "document" }) });
    expect((res as CfResponse).headers!.location.value).toBe("/apps/photos/sign-in");
  });

  it("with no-store, because the answer depends on a cookie", () => {
    const res = handler({ request: req("/apps/memo/browse", { dest: "document" }) });
    expect((res as CfResponse).headers!["cache-control"].value).toBe("no-store");
  });
});

describe("passes through", () => {
  it("a viewer who already has a session cookie", () => {
    const r = req("/apps/memo/browse", { dest: "document", cookie: "sk_session=abc" });
    expect(handler({ request: r })).toBe(r);
  });

  it("the sign-in page itself, or the redirect would loop", () => {
    const r = req("/apps/memo/sign-in", { dest: "document" });
    expect(handler({ request: r })).toBe(r);
  });

  it("the reserved data plane — a device signs these and holds no cookie", () => {
    // Not a preference. A paired handset presents an Ed25519 signature and no
    // cookie at all, so redirecting these would break device sync outright.
    for (const sub of ["data/records", "files/x", "sync/exchange", "app-data/db/decks", "health"]) {
      const r = req(`/apps/photos/${sub}`, { dest: "document" });
      expect(handler({ request: r }), sub).toBe(r);
    }
  });

  it("the runtime config, which sign-in needs before it can render", () => {
    const r = req("/apps/memo/starkeep-runtime-config", { dest: "document" });
    expect(handler({ request: r })).toBe(r);
  });

  it("an XHR, which must get the origin's 401 rather than an HTML page", () => {
    // An expired data call handed a sign-in page parses it as a corrupt
    // response instead of as "you are signed out".
    for (const dest of ["empty", "script", "style", "image", undefined]) {
      const r = req("/apps/memo/api/local-data/x", dest ? { dest } : {});
      expect(handler({ request: r }), String(dest)).toBe(r);
    }
  });

  it("anything outside /apps/<appId>", () => {
    for (const uri of ["/", "/health", "/shared/image/ab/hash", "/apps"]) {
      const r = req(uri, { dest: "document" });
      expect(handler({ request: r }), uri).toBe(r);
    }
  });

  it("a static chunk, which this behavior is not attached to anyway", () => {
    // Belt and braces: the function is associated only with the default cache
    // behavior, never with /apps/*/_next/static/*, which forwards no cookies
    // and must keep its cache. If it were ever attached there, this case says
    // what should happen.
    const r = req("/apps/memo/_next/static/chunks/main.js", { dest: "script" });
    expect(handler({ request: r })).toBe(r);
  });
});

describe("wiring", () => {
  it("is attached to the default behavior only", () => {
    const program = readFileSync(
      resolve(PKG_DIR, "src", "builtin-programs", "cloud-data-server-program.ts"),
      "utf-8",
    );
    const associations = program.match(/functionAssociations/g) ?? [];
    expect(
      associations,
      "the static-asset behavior forwards no cookies and must keep its cache",
    ).toHaveLength(1);
    const defaultBlock = program.slice(program.indexOf("defaultCacheBehavior:"));
    expect(defaultBlock).toContain("functionAssociations");
  });
});
