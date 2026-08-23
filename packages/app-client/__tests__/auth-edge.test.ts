/**
 * The deny-by-default origin gate.
 *
 * The property worth stating plainly: the assertions below are mostly about
 * what the gate *refuses*. A gate tested only on the paths it allows is a gate
 * whose default nobody has checked, and the default is the whole design.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createAuthGateMiddleware } from "../src/edge.js";

const DEFAULT_PUBLIC = ["/", "/_next/static/*", "/starkeep-runtime-config"];
const savedMode = process.env.STARKEEP_APP_CLIENT_MODE;

const gate = createAuthGateMiddleware({
  publicPaths: [...DEFAULT_PUBLIC, "/sign-in", "/api/session/*"],
  signInPath: "/sign-in",
  basePath: "/apps/memo",
});

function req(path: string, init: { cookie?: string; dest?: string; method?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = init.cookie;
  if (init.dest) headers["sec-fetch-dest"] = init.dest;
  return new Request(`https://cdn.example.com${path}`, {
    method: init.method ?? "GET",
    headers,
  });
}

beforeEach(() => {
  process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
});

afterEach(() => {
  if (savedMode === undefined) delete process.env.STARKEEP_APP_CLIENT_MODE;
  else process.env.STARKEEP_APP_CLIENT_MODE = savedMode;
});

describe("createAuthGateMiddleware", () => {
  it("allows each of the three platform defaults with no cookie", () => {
    expect(gate(req("/apps/memo/"))).toBeUndefined();
    expect(gate(req("/apps/memo/_next/static/chunks/main.js"))).toBeUndefined();
    expect(gate(req("/apps/memo/starkeep-runtime-config"))).toBeUndefined();
  });

  it("allows the sign-in page and the session routes, or nobody could sign in", () => {
    expect(gate(req("/apps/memo/sign-in"))).toBeUndefined();
    expect(gate(req("/apps/memo/api/session/sign-in", { method: "POST" }))).toBeUndefined();
    expect(gate(req("/apps/memo/api/session"))).toBeUndefined();
  });

  it("denies an undeclared path", () => {
    const res = gate(req("/apps/memo/api/local-data/app-data/db/decks", { dest: "empty" }));
    expect(res?.status).toBe(401);
  });

  it("denies an undeclared SSR route, not only the API surface", () => {
    expect(gate(req("/apps/memo/decks", { dest: "document" }))?.status).toBe(302);
  });

  it("redirects a document request to the app's own sign-in page", () => {
    const res = gate(req("/apps/memo/decks", { dest: "document" }));
    // Absolute, because Next parses this with `new URL(...)` and a path-only
    // value throws — a 500 where a 302 was meant.
    expect(res?.headers.get("location")).toBe("https://cdn.example.com/apps/memo/sign-in");
  });

  it("gives an XHR a 401 rather than an HTML redirect it cannot parse", () => {
    const res = gate(req("/apps/memo/api/local-data/x", { dest: "empty" }));
    expect(res?.status).toBe(401);
    expect(res?.headers.get("content-type")).toContain("application/json");
  });

  it("lets a request carrying a session cookie through to the real gate", () => {
    expect(gate(req("/apps/memo/api/local-data/x", { cookie: "sk_session=abc" }))).toBeUndefined();
  });

  it("matches /_next/static/* as a prefix, not as a literal", () => {
    expect(gate(req("/apps/memo/_next/static/css/a/b/c.css"))).toBeUndefined();
    // The prefix must not leak to a sibling that merely starts with the text.
    expect(gate(req("/apps/memo/_next/staticky", { dest: "empty" }))?.status).toBe(401);
  });

  it("does not let the root entry match every path", () => {
    expect(gate(req("/apps/memo/anything", { dest: "empty" }))?.status).toBe(401);
  });

  it("is inert outside cloud mode — local-first means no sign-in on local data", () => {
    delete process.env.STARKEEP_APP_CLIENT_MODE;
    expect(gate(req("/apps/memo/api/local-data/app-data/db/decks"))).toBeUndefined();
    process.env.STARKEEP_APP_CLIENT_MODE = "local";
    expect(gate(req("/apps/memo/api/local-data/app-data/db/decks"))).toBeUndefined();
  });

  it("works with no basePath, for an app served at the root", () => {
    const rootGate = createAuthGateMiddleware({
      publicPaths: DEFAULT_PUBLIC,
      signInPath: "/sign-in",
    });
    expect(rootGate(req("/"))).toBeUndefined();
    expect(rootGate(req("/decks", { dest: "document" }))?.headers.get("location")).toBe(
      "https://cdn.example.com/sign-in",
    );
  });
});
