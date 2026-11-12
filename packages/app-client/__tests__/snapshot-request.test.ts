/**
 * The snapshot helper bound to a request: who may read, whose rows load, and
 * how the rows arrive.
 *
 * The proxy, the credential loader and the session module are mocked, as in
 * `data-proxy-user-token.test.ts`, so each test can say what the data server
 * answered and which user the session named.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSnapshotSql,
  SnapshotAccessError,
  SnapshotLoadError,
  type SnapshotTable,
} from "../src/snapshot.js";
import type { MinimalRequest } from "../src/index.js";

const proxyMock = vi.hoisted(() => ({ proxyToDataServer: vi.fn() }));
vi.mock("../src/proxy.js", () => proxyMock);
vi.mock("../src/proxy", () => proxyMock);

const sessionMock = vi.hoisted(() => ({ mintIdToken: vi.fn(), requireSession: vi.fn() }));
vi.mock("../src/auth/session.js", () => sessionMock);

const credsMock = vi.hoisted(() => ({
  loadAppCredentials: vi.fn(),
  clearAppCredentialsCache: vi.fn(),
}));
vi.mock("../src/credentials.js", () => credsMock);
vi.mock("../src/credentials", () => credsMock);

const TABLES: SnapshotTable[] = [
  {
    name: "notes",
    columns: [
      { name: "record_id", type: "text" },
      { name: "note", type: "text" },
    ],
  },
];

const COUNT = "SELECT count(*) AS n FROM notes";
const savedMode = process.env.STARKEEP_APP_CLIENT_MODE;

/** Pages the fake data server answers, keyed by user token ("" on the local surface). */
let pagesByUser: Record<string, Array<{ rows: unknown[]; page_token: string | null }>>;

function respond(status: number, body: unknown) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: new Response(JSON.stringify(body)).body,
  };
}

beforeEach(() => {
  pagesByUser = {};
  proxyMock.proxyToDataServer.mockReset();
  proxyMock.proxyToDataServer.mockImplementation(
    async (_creds: unknown, req: { path: string; userToken?: string }) => {
      const pages = pagesByUser[req.userToken ?? ""] ?? [{ rows: [], page_token: null }];
      const token = new URL(`http://x${req.path}`).searchParams.get("page_token");
      return respond(200, pages[token ? Number(token) : 0]);
    },
  );
  sessionMock.mintIdToken.mockReset();
  credsMock.loadAppCredentials.mockReset();
  credsMock.loadAppCredentials.mockResolvedValue({
    appId: "testapp",
    hmacSecret: "s3cret",
    dataServerUrl: "http://127.0.0.1:9999",
  });
  delete process.env.STARKEEP_APP_CLIENT_MODE;
});

afterEach(() => {
  if (savedMode === undefined) delete process.env.STARKEEP_APP_CLIENT_MODE;
  else process.env.STARKEEP_APP_CLIENT_MODE = savedMode;
});

function request(headers: Record<string, string> = {}): MinimalRequest {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method: "GET",
    url: "http://localhost:3000/api/summary",
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    text: async () => "",
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function helper() {
  return createSnapshotSql({ appId: "testapp", tables: TABLES });
}

const query = { tables: ["notes"], sql: COUNT, maxAge: 60_000 };

describe("loading rows through the row API", () => {
  it("follows page_token until the table is exhausted", async () => {
    pagesByUser[""] = [
      { rows: [{ record_id: "a" }, { record_id: "b" }], page_token: "1" },
      { rows: [{ record_id: "c" }], page_token: null },
    ];
    const result = await helper().query(request(), query);
    expect(result.rows).toEqual([{ n: 3 }]);

    const paths = proxyMock.proxyToDataServer.mock.calls.map((c) => c[1].path);
    expect(paths).toEqual([
      "/app-data/db/notes?limit=500",
      "/app-data/db/notes?limit=500&page_token=1",
    ]);
    expect(proxyMock.proxyToDataServer.mock.calls[0]![1].method).toBe("GET");
  });

  it("raises SnapshotLoadError with the data server's status and message", async () => {
    proxyMock.proxyToDataServer.mockResolvedValue(
      respond(400, { error: "limit must be at most 500" }),
    );
    const err = await helper()
      .query(request(), query)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapshotLoadError);
    expect((err as SnapshotLoadError).status).toBe(400);
    expect((err as Error).message).toContain("limit must be at most 500");
  });

  it("answers 503 when the app has no credential", async () => {
    credsMock.loadAppCredentials.mockResolvedValue(null);
    const err = await helper()
      .query(request(), query)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapshotAccessError);
    expect((err as SnapshotAccessError).status).toBe(503);
  });

  it("does not read the credential when the snapshot answers from the cache", async () => {
    const snapshots = helper();
    await snapshots.query(request(), query);
    await snapshots.query(request(), query);
    expect(credsMock.loadAppCredentials).toHaveBeenCalledTimes(1);
    expect(proxyMock.proxyToDataServer).toHaveBeenCalledTimes(1);
  });
});

describe("the local surface", () => {
  it("asks for no end user and sends no token", async () => {
    await helper().query(request(), query);
    expect(sessionMock.mintIdToken).not.toHaveBeenCalled();
    expect(proxyMock.proxyToDataServer.mock.calls[0]![1].userToken).toBeUndefined();
  });

  it("refuses a request a page on another site sent", async () => {
    const err = await helper()
      .query(request({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" }), query)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapshotAccessError);
    expect((err as SnapshotAccessError).status).toBe(403);
    expect(proxyMock.proxyToDataServer).not.toHaveBeenCalled();
  });
});

describe("the cloud surface", () => {
  beforeEach(() => {
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
  });

  it("refuses a request with no session before reading the credential", async () => {
    sessionMock.mintIdToken.mockResolvedValue(null);
    const err = await helper()
      .query(request(), query)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapshotAccessError);
    expect((err as SnapshotAccessError).status).toBe(401);
    expect(credsMock.loadAppCredentials).not.toHaveBeenCalled();
    expect(proxyMock.proxyToDataServer).not.toHaveBeenCalled();
  });

  it("forwards the user's token and keeps each user's snapshot apart", async () => {
    pagesByUser["token-u1"] = [
      { rows: [{ record_id: "a" }, { record_id: "b" }], page_token: null },
    ];
    pagesByUser["token-u2"] = [{ rows: [{ record_id: "z" }], page_token: null }];
    const snapshots = helper();

    sessionMock.mintIdToken.mockResolvedValue({ token: "token-u1", claims: { sub: "u1", exp: 0 } });
    expect((await snapshots.query(request(), query)).rows).toEqual([{ n: 2 }]);

    // Same warm instance, another user: their own load, never u1's copy.
    sessionMock.mintIdToken.mockResolvedValue({ token: "token-u2", claims: { sub: "u2", exp: 0 } });
    expect((await snapshots.query(request(), query)).rows).toEqual([{ n: 1 }]);

    sessionMock.mintIdToken.mockResolvedValue({ token: "token-u1", claims: { sub: "u1", exp: 0 } });
    expect((await snapshots.query(request(), query)).rows).toEqual([{ n: 2 }]);

    const tokens = proxyMock.proxyToDataServer.mock.calls.map((c) => c[1].userToken);
    expect(tokens).toEqual(["token-u1", "token-u2"]);
  });

  it("returns the re-minted cookie for the app to echo", async () => {
    sessionMock.mintIdToken.mockResolvedValue({
      token: "fresh",
      claims: { sub: "u1", exp: 0 },
      setCookie: "sk_token=fresh; Path=/apps/testapp; HttpOnly",
    });
    const result = await helper().query(request(), query);
    expect(result.setCookie).toBe("sk_token=fresh; Path=/apps/testapp; HttpOnly");
  });
});
