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
 * real handler would drag in the filesystem, AWS and child processes for
 * assertions that are about none of those.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDataDir } from "./helpers";

process.env.STARKEEP_DIR = makeDataDir("adminweb-api-routing-");

/** Records which route module ran, and with what. */
const seen: Array<{ module: string; export: string; url: string; params?: unknown }> = [];

function spy(moduleName: string, exportNames: string[]) {
  const mod: Record<string, unknown> = {};
  for (const name of exportNames) {
    mod[name] = (req?: Request, ctx?: { params: Promise<Record<string, string>> }) => {
      seen.push({
        module: moduleName,
        export: name,
        url: req?.url ?? "",
        params: ctx?.params,
      });
      return Response.json({ module: moduleName, export: name });
    };
  }
  return mod;
}

vi.mock("../src/routes/apps-list", () => spy("apps-list", ["GET"]));
vi.mock("../src/routes/apps-install", () => spy("apps-install", ["POST"]));
vi.mock("../src/routes/apps-uninstall", () => spy("apps-uninstall", ["POST"]));
vi.mock("../src/routes/apps-cloud-list", () => spy("apps-cloud-list", ["POST"]));
vi.mock("../src/routes/apps-cloud-install", () => spy("apps-cloud-install", ["POST"]));
vi.mock("../src/routes/apps-install-status", () => spy("apps-install-status", ["GET"]));
vi.mock("../src/routes/cloud-data-server-install", () =>
  spy("cloud-data-server-install", ["POST"]),
);
vi.mock("../src/routes/config", () => spy("config", ["GET", "PATCH"]));
vi.mock("../src/routes/costs", () => spy("costs", ["POST"]));
vi.mock("../src/routes/devices", () => spy("devices", ["POST", "DELETE"]));
vi.mock("../src/routes/drive-install", () => spy("drive-install", ["POST"]));
vi.mock("../src/routes/exec-daemon", () => spy("exec-daemon", ["POST"]));
vi.mock("../src/routes/exec-daemon-status", () => spy("exec-daemon-status", ["GET"]));
vi.mock("../src/routes/exec-deploy-outputs", () => spy("exec-deploy-outputs", ["GET"]));
vi.mock("../src/routes/exec-stream", () => spy("exec-stream", ["POST"]));
vi.mock("../src/routes/residency", () => spy("residency", ["GET"]));
vi.mock("../src/routes/residency-policy", () => spy("residency-policy", ["POST", "PUT"]));
vi.mock("../src/routes/runtime-config", () => spy("runtime-config", ["GET"]));

const { api } = await import("../src/api");

const ORIGIN = "http://localhost:3000";

async function call(method: string, path: string): Promise<Response> {
  return api.request(new Request(`${ORIGIN}${path}`, { method }));
}

beforeEach(() => {
  seen.length = 0;
});

/** Every route the browser half calls, and the module each must reach. */
const ROUTES: Array<[string, string, string, string]> = [
  ["GET", "/api/apps/list", "apps-list", "GET"],
  ["POST", "/api/apps/install", "apps-install", "POST"],
  ["POST", "/api/apps/uninstall", "apps-uninstall", "POST"],
  ["POST", "/api/apps/cloud/list", "apps-cloud-list", "POST"],
  ["POST", "/api/apps/photos/cloud-install", "apps-cloud-install", "POST"],
  ["GET", "/api/apps/photos/install-status", "apps-install-status", "GET"],
  ["POST", "/api/cloud-data-server/install", "cloud-data-server-install", "POST"],
  ["GET", "/api/config", "config", "GET"],
  ["PATCH", "/api/config", "config", "PATCH"],
  ["POST", "/api/costs", "costs", "POST"],
  ["POST", "/api/devices", "devices", "POST"],
  ["DELETE", "/api/devices", "devices", "DELETE"],
  ["POST", "/api/drive/install", "drive-install", "POST"],
  ["POST", "/api/exec/daemon", "exec-daemon", "POST"],
  ["GET", "/api/exec/daemon/status", "exec-daemon-status", "GET"],
  ["GET", "/api/exec/deploy-outputs", "exec-deploy-outputs", "GET"],
  ["POST", "/api/exec/stream", "exec-stream", "POST"],
  ["GET", "/api/residency", "residency", "GET"],
  ["POST", "/api/residency/policy", "residency-policy", "POST"],
  ["PUT", "/api/residency/policy", "residency-policy", "PUT"],
  ["GET", "/api/runtime-config", "runtime-config", "GET"],
];

describe("every route reaches its handler", () => {
  it.each(ROUTES)("%s %s → %s.%s", async (method, path, module, exportName) => {
    const res = await call(method, path);
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ module, export: exportName });
  });

  it("covers the whole route table, so a route added without a case is visible", () => {
    // `api.routes` is Hono's own list. The catch-all is excluded: it is the
    // absence of a route rather than one.
    const mounted = api.routes
      .filter((r) => r.path !== "/api/*")
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(mounted).toHaveLength(ROUTES.length);
  });
});

describe("paths that must not collide", () => {
  it("prefers the static /apps/cloud/list over the :appId route of the same depth", async () => {
    // `/api/apps/:appId/install-status` is four segments and so is
    // `/api/apps/cloud/list`. A router that matched on shape rather than on the
    // literal would send the registry read to the install-status handler.
    await call("POST", "/api/apps/cloud/list");
    expect(seen[0]).toMatchObject({ module: "apps-cloud-list" });
  });

  it("prefers /apps/list over :appId", async () => {
    await call("GET", "/api/apps/list");
    expect(seen[0]).toMatchObject({ module: "apps-list" });
  });

  it("keeps /exec/daemon and /exec/daemon/status apart", async () => {
    await call("POST", "/api/exec/daemon");
    await call("GET", "/api/exec/daemon/status");
    expect(seen.map((s) => s.module)).toEqual(["exec-daemon", "exec-daemon-status"]);
  });

  it("keeps /residency and /residency/policy apart", async () => {
    await call("GET", "/api/residency");
    await call("PUT", "/api/residency/policy");
    expect(seen.map((s) => s.module)).toEqual(["residency", "residency-policy"]);
  });
});

describe("the dynamic segment", () => {
  it("hands the handler the app id from the path", async () => {
    await call("POST", "/api/apps/memo/cloud-install");
    expect(await (seen[0]!.params as Promise<{ appId: string }>)).toEqual({ appId: "memo" });
  });

  it("decodes a percent-encoded id", async () => {
    // The case Memo hit: an id arriving encoded and never matching anything.
    await call("GET", `/api/apps/${encodeURIComponent("my app")}/install-status`);
    expect(await (seen[0]!.params as Promise<{ appId: string }>)).toEqual({ appId: "my app" });
  });
});

describe("what is not a route", () => {
  it("answers an unknown /api path with JSON, not the SPA shell", async () => {
    // A client route falls through to index.html. An /api path must not: an
    // XHR handed HTML parses it as a corrupt response rather than as a 404.
    const res = await call("GET", "/api/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(((await res.json()) as { error: string }).error).toContain("/api/nope");
    expect(seen).toHaveLength(0);
  });

  it("answers a known path with the wrong method as an unrouted API path", async () => {
    const res = await call("DELETE", "/api/apps/list");
    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it("claims nothing outside /api", async () => {
    const res = await api.request(new Request(`${ORIGIN}/storage`));
    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
  });
});
