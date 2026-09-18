/**
 * The two removal routes, against a stub data server.
 *
 * Both are thin proxies, and what a proxy is worth testing for is which
 * upstream it calls. That matters more here than usual: the three requests
 * these routes can make — uninstall, uninstall deleting the data, and drop this
 * node's copy — differ only in a query parameter and a path suffix, and each
 * pair destroys something the other one keeps.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jsonRequest, makeDataDir, startStubServer, type StubServer } from "./helpers";

let uninstall: (req: Request) => Promise<Response>;
let removeFromNode: (req: Request) => Promise<Response>;
let upstream: StubServer;

beforeAll(async () => {
  process.env.STARKEEP_DIR = makeDataDir("adminweb-removal-");
  upstream = await startStubServer(() => ({ status: 200, body: JSON.stringify({ ok: true }) }));
  process.env.STARKEEP_LOCAL_DATA_SERVER_URL = upstream.url;
  ({ POST: uninstall } = await import("../src/routes/apps-uninstall"));
  ({ POST: removeFromNode } = await import("../src/routes/apps-remove-node"));
});

afterAll(async () => {
  await upstream.stop();
});

const lastCall = () => upstream.seen.at(-1)!;

describe("POST /api/apps/uninstall", () => {
  it("keeps the app's data unless asked to delete it", async () => {
    const res = await uninstall(jsonRequest("/api/apps/uninstall", { appId: "photos" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ appId: "photos", deleteData: false });
    // No query string at all, which is what the data server reads as "keep it".
    expect(lastCall()).toMatchObject({ method: "DELETE", url: "/admin/apps/photos" });
  });

  it("forwards deleteData when the caller asks for the destructive half", async () => {
    const res = await uninstall(
      jsonRequest("/api/apps/uninstall", { appId: "photos", deleteData: true }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ appId: "photos", deleteData: true });
    expect(lastCall()).toMatchObject({
      method: "DELETE",
      url: "/admin/apps/photos?deleteData=1",
    });
  });

  it("does not read a stray retainData as permission to delete", async () => {
    // The flag this route used to take, sent by a caller that has not been
    // updated. It is not the flag any more, and the outcome an unknown field
    // produces has to be the safe one rather than the old one inverted.
    const res = await uninstall(
      jsonRequest("/api/apps/uninstall", { appId: "photos", retainData: false }),
    );
    expect(res.status).toBe(200);
    expect(lastCall()).toMatchObject({ method: "DELETE", url: "/admin/apps/photos" });
  });

  it("rejects a missing appId with 400 and calls nothing", async () => {
    const before = upstream.seen.length;
    const res = await uninstall(jsonRequest("/api/apps/uninstall", {}));
    expect(res.status).toBe(400);
    expect(upstream.seen.length).toBe(before);
  });
});

describe("POST /api/apps/remove-from-node", () => {
  it("addresses the node-copy route, which propagates nothing to peers", async () => {
    const res = await removeFromNode(
      jsonRequest("/api/apps/remove-from-node", { appId: "photos" }),
    );
    expect(res.status).toBe(200);
    expect(lastCall()).toMatchObject({ method: "DELETE", url: "/admin/apps/photos/node-copy" });
  });

  it("encodes an app id that would otherwise reshape the upstream path", async () => {
    await removeFromNode(jsonRequest("/api/apps/remove-from-node", { appId: "a/b" }));
    expect(lastCall().url).toBe("/admin/apps/a%2Fb/node-copy");
  });

  it("rejects a missing appId with 400 and calls nothing", async () => {
    const before = upstream.seen.length;
    const res = await removeFromNode(jsonRequest("/api/apps/remove-from-node", {}));
    expect(res.status).toBe(400);
    expect(upstream.seen.length).toBe(before);
  });
});
