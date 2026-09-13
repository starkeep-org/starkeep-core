/**
 * The route table: which path and method reaches which handler.
 *
 * Every other file in this suite calls a handler directly, which says nothing
 * about whether a request can get to it. That used to be the directory tree's
 * job and is now `src/api.ts`'s, and a router change is exactly the kind of
 * thing that silently reroutes a path — Memo already hit the percent-encoding
 * case, where every deck reported "Deck not found" because a dynamic segment
 * arrived encoded.
 *
 * The handlers are replaced by spies. What is under test is the dispatch, and a
 * real handler would open a SQLite registry and talk to the data server for
 * assertions that are about neither.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Records which route module ran, and with what. */
const seen: Array<{ module: string; url: string; id?: string }> = [];

function spy(moduleName: string) {
  return {
    GET: (req?: Request, id?: string) => {
      seen.push({ module: moduleName, url: req?.url ?? "", id });
      return Response.json({ module: moduleName });
    },
  };
}

vi.mock("../src/routes/events", () => spy("events"));
vi.mock("../src/routes/records", () => spy("records"));
vi.mock("../src/routes/record-file", () => spy("record-file"));
vi.mock("../src/routes/types", () => spy("types"));

const { api } = await import("../src/api");

const ORIGIN = "http://localhost:9830";

async function call(method: string, path: string): Promise<Response> {
  return api.request(new Request(`${ORIGIN}${path}`, { method }));
}

beforeEach(() => {
  seen.length = 0;
});

/** Every route the browser half calls, and the module each must reach. */
const ROUTES: Array<[string, string, string]> = [
  ["GET", "/api/events", "events"],
  ["GET", "/api/records", "records"],
  ["GET", "/api/records/rec-1/file", "record-file"],
  ["GET", "/api/types", "types"],
];

describe("every declared route reaches its handler", () => {
  it.each(ROUTES)("%s %s → %s", async (method, path, module) => {
    const res = await call(method, path);

    expect(res.status).toBe(200);
    expect(seen).toEqual([expect.objectContaining({ module })]);
  });

  it("covers every route the app mounts", () => {
    // A route added to `src/api.ts` and not to the list above would otherwise
    // go untested, which is the drift this file exists to prevent. The
    // catch-all is excluded: it is asserted separately below.
    const mounted = api.routes
      .filter((r) => r.path !== "/api/*")
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    const declared = ROUTES.map(([method, path]) =>
      `${method} ${path.replace("/rec-1/", "/:id/")}`,
    ).sort();

    expect(mounted).toEqual(declared);
  });
});

describe("the dynamic segment", () => {
  it("reaches the handler as its own argument, decoded", () => {
    // A record id is signed and looked up as itself. The framework this
    // replaced handed the id through encoded, and Memo's workaround for it is
    // still in that tree.
    return call("GET", "/api/records/rec%2Fwith%2Fslashes/file").then(() => {
      expect(seen[0].id).toBe("rec/with/slashes");
    });
  });

  it("carries the query string through to the handler", async () => {
    await call("GET", "/api/records/rec-1/file?type=image%2Fpng");

    expect(seen[0].url).toContain("type=image%2Fpng");
  });
});

describe("an unrouted path", () => {
  it("answers JSON rather than falling through to the client", async () => {
    // A 404 that rendered the shell would be parsed as JSON by the caller and
    // fail somewhere else entirely.
    const res = await call("GET", "/api/nope");

    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain("GET /api/nope");
    expect(seen).toEqual([]);
  });

  it("answers 404 for a method no route declares", async () => {
    const res = await call("POST", "/api/records");

    expect(res.status).toBe(404);
    expect(seen).toEqual([]);
  });
});
