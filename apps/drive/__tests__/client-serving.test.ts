/**
 * Which half of the server owns a path, and what the built client answers with.
 *
 * Under the framework this was the framework's: the `app/` tree decided what
 * was a route and what was an asset, and an SPA fallback was something it did
 * rather than something written down. `src/client-serving.ts` is where the
 * decision lives now, so it is a decision with a test.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DIST_DIR,
  isClientRoute,
  isServerPath,
  resolveClientRequest,
  SHELL,
} from "../src/client-serving";

/**
 * A real build is not required and not wanted: the decision under test is about
 * paths on disk, so the files it reads are written here and removed after.
 * Anything the real `vite build` left behind is preserved.
 */
const written: string[] = [];

function stage(relative: string, body = "x"): void {
  const file = join(DIST_DIR, relative);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, body);
  written.push(file);
}

beforeAll(() => {
  mkdirSync(DIST_DIR, { recursive: true });
  stage("_immutable/index-abc123.js");
  stage("_immutable/index-abc123.css");
  stage("favicon.png");
});

afterAll(() => {
  for (const file of written) rmSync(file, { force: true });
});

describe("which half owns a path", () => {
  it.each(["/api", "/api/records", "/api/records/rec-1/file", "/api/nope"])(
    "%s is the server's",
    (path) => {
      expect(isServerPath(path)).toBe(true);
    },
  );

  it.each(["/", "/apiary", "/_immutable/index-abc123.js", "/favicon.png"])(
    "%s is the client's",
    (path) => {
      // `/apiary` is the case a `startsWith("/api")` test gets wrong.
      expect(isServerPath(path)).toBe(false);
    },
  );
});

describe("the client routes", () => {
  it("are the one screen Drive has", () => {
    expect(isClientRoute("/")).toBe(true);
  });

  it("do not include a path nothing serves", () => {
    // Declared rather than a blanket fallback: an undeclared path 404s instead
    // of rendering the app under a URL that will never work again.
    expect(isClientRoute("/browse")).toBe(false);
    expect(resolveClientRequest("/browse")).toEqual({ kind: "notFound" });
  });
});

describe("what a path resolves to", () => {
  it("answers the root with the shell", () => {
    // `/` joins to the build directory itself, and reading a directory throws
    // EISDIR — a 500 on the app's own front page.
    expect(resolveClientRequest("/")).toEqual({ kind: "shell", file: SHELL });
  });

  it("answers a hashed asset with the file, cacheable forever", () => {
    const answer = resolveClientRequest("/_immutable/index-abc123.js");

    expect(answer.kind).toBe("asset");
    expect(answer).toMatchObject({
      contentType: "application/javascript; charset=utf-8",
      cacheControl: "public, max-age=31536000, immutable",
    });
  });

  it("makes everything outside that prefix revalidate", () => {
    // The shell is the one file whose contents change while its name does not.
    expect(resolveClientRequest("/favicon.png")).toMatchObject({
      kind: "asset",
      contentType: "image/png",
      cacheControl: "no-cache",
    });
  });

  it("prefers a real file over the shell", () => {
    // The same precedence the platform's web adapter applies in the cloud.
    stage("index.html", "<!doctype html>");
    expect(resolveClientRequest("/")).toEqual({ kind: "shell", file: SHELL });
    expect(resolveClientRequest("/_immutable/index-abc123.css")).toMatchObject({ kind: "asset" });
  });

  it("serves bytes for a type it does not recognise rather than guessing", () => {
    stage("odd.xyz");
    expect(resolveClientRequest("/odd.xyz")).toMatchObject({
      contentType: "application/octet-stream",
    });
  });
});

describe("path containment", () => {
  it.each([
    "/../package.json",
    "/_immutable/../../package.json",
    "/%2e%2e/package.json",
  ])("refuses %s", (path) => {
    // A `..` that climbed out of the build must not be read, whatever it points
    // at — and the decoded form is the one a naive check misses.
    expect(resolveClientRequest(path)).toEqual({ kind: "notFound" });
  });

  it("refuses a malformed escape instead of throwing", () => {
    // `decodeURIComponent` throws on a lone `%`, and a throw here would be a
    // 500 where a 404 is the answer.
    expect(resolveClientRequest("/%")).toEqual({ kind: "notFound" });
  });
});
