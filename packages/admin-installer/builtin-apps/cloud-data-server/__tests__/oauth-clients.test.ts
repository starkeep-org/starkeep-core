/**
 * Client ID metadata documents: which `client_id` URLs the server will fetch,
 * which addresses it will connect to, what a document must say, how long it
 * is cached, and how redirect URIs match.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheMsFor,
  checkClientDocument,
  clientIdUrl,
  fetchDocument,
  guardedLookup,
  isLoopbackRedirect,
  isPublicAddress,
  loadClient,
  MAX_CACHE_MS,
  MIN_CACHE_MS,
  redirectUriMatches,
  resetClientCache,
  type FetchedDocument,
} from "../src/oauth-clients.js";

const CLIENT = "https://client.example/oauth/metadata.json";

function doc(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    client_id: CLIENT,
    client_name: "Example client",
    redirect_uris: ["https://client.example/callback", "http://127.0.0.1/callback"],
    token_endpoint_auth_method: "none",
    ...over,
  });
}

beforeEach(() => {
  resetClientCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("clientIdUrl", () => {
  it("accepts an https URL with a path", () => {
    expect(clientIdUrl(CLIENT)?.host).toBe("client.example");
  });

  it.each([
    ["an http URL", "http://client.example/meta.json"],
    ["no path", "https://client.example"],
    ["the root path", "https://client.example/"],
    ["a fragment", "https://client.example/meta.json#x"],
    ["credentials", "https://user:pw@client.example/meta.json"],
    ["a non-default port", "https://client.example:8443/meta.json"],
    ["an IPv4 literal", "https://10.0.0.1/meta.json"],
    ["an IPv6 literal", "https://[::1]/meta.json"],
    ["a spelling that normalizes", "https://CLIENT.example/meta.json"],
    ["dot segments", "https://client.example/a/../meta.json"],
    ["nothing", undefined],
    ["not a URL", "client"],
  ])("refuses %s", (_label, raw) => {
    expect(clientIdUrl(raw)).toBeNull();
  });
});

describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "64:ff9b::a00:1",
    "2002:a00:1::",
    "not-an-ip",
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"])("allows %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe("guardedLookup", () => {
  function run(addresses: { address: string; family: number }[], all = false) {
    return new Promise<{ err: NodeJS.ErrnoException | null; result: unknown }>((resolve) =>
      guardedLookup(async () => addresses)("client.example", { all }, (err, result) =>
        resolve({ err, result }),
      ),
    );
  }

  it("answers the first address when every one is public", async () => {
    const { err, result } = await run([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    expect(err).toBeNull();
    expect(result).toBe("93.184.216.34");
  });

  it("answers the list when the caller asks for all", async () => {
    const addresses = [{ address: "93.184.216.34", family: 4 }];
    expect((await run(addresses, true)).result).toEqual(addresses);
  });

  it("refuses a hostname when any address is private", async () => {
    const { err } = await run([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    expect(err?.code).toBe("ENOTPUBLIC");
  });

  it("stops a real https request before it connects", async () => {
    const lookup = guardedLookup(async () => [{ address: "169.254.169.254", family: 4 }]);
    await expect(
      fetchDocument(new URL("https://metadata.example/latest"), {
        lookup: lookup as never,
      }),
    ).rejects.toMatchObject({ code: "ENOTPUBLIC" });
  });
});

describe("checkClientDocument", () => {
  it("reads the name and the redirect URIs", () => {
    const result = checkClientDocument(CLIENT, doc());
    expect(result).toEqual({
      ok: true,
      client: {
        clientId: CLIENT,
        clientName: "Example client",
        redirectUris: ["https://client.example/callback", "http://127.0.0.1/callback"],
      },
    });
  });

  it("allows an absent auth method and an absent name", () => {
    const result = checkClientDocument(
      CLIENT,
      doc({ token_endpoint_auth_method: undefined, client_name: undefined }),
    );
    expect(result.ok && result.client.clientName).toBeNull();
  });

  it("strips control characters from the name and bounds its length", () => {
    const result = checkClientDocument(CLIENT, doc({ client_name: `a\u0007b${"x".repeat(100)}` }));
    expect(result.ok && result.client.clientName).toBe(`ab${"x".repeat(62)}`);
  });

  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["a mismatched client_id", doc({ client_id: "https://other.example/meta.json" })],
    ["no redirect URIs", doc({ redirect_uris: [] })],
    ["a redirect URI that is not a string", doc({ redirect_uris: [5] })],
    ["a plain http redirect URI", doc({ redirect_uris: ["http://client.example/cb"] })],
    ["a confidential client", doc({ token_endpoint_auth_method: "client_secret_basic" })],
  ])("refuses %s", (_label, body) => {
    expect(checkClientDocument(CLIENT, body).ok).toBe(false);
  });
});

describe("cacheMsFor", () => {
  it("keeps a document for its max-age within the bounds", () => {
    expect(cacheMsFor("public, max-age=900")).toBe(900_000);
    expect(cacheMsFor("max-age=10")).toBe(MIN_CACHE_MS);
    expect(cacheMsFor("max-age=999999")).toBe(MAX_CACHE_MS);
    expect(cacheMsFor(undefined)).toBe(MIN_CACHE_MS);
    expect(cacheMsFor("no-store")).toBe(MIN_CACHE_MS);
  });
});

describe("loadClient", () => {
  function serve(answers: FetchedDocument[]) {
    const calls: string[] = [];
    return {
      calls,
      fetchDocument: async (url: URL) => {
        calls.push(url.href);
        return answers.shift()!;
      },
    };
  }

  it("fetches once and serves the cache until max-age passes", async () => {
    let now = 1_000_000;
    const source = serve([
      { status: 200, cacheControl: "max-age=600", body: doc() },
      { status: 200, cacheControl: "max-age=600", body: doc({ client_name: "Renamed" }) },
    ]);
    const deps = { ...source, now: () => now };
    expect((await loadClient(CLIENT, deps)).ok).toBe(true);
    now += 599_000;
    expect((await loadClient(CLIENT, deps)).ok).toBe(true);
    expect(source.calls).toHaveLength(1);
    now += 2_000;
    const third = await loadClient(CLIENT, deps);
    expect(third.ok && third.client.clientName).toBe("Renamed");
    expect(source.calls).toHaveLength(2);
  });

  it("refuses a URL it may not fetch without fetching", async () => {
    const source = serve([]);
    expect((await loadClient("http://client.example/meta.json", source)).ok).toBe(false);
    expect(source.calls).toEqual([]);
  });

  it("refuses a redirect and does not cache a failure", async () => {
    const source = serve([
      { status: 302, cacheControl: undefined, body: "" },
      { status: 200, cacheControl: undefined, body: doc() },
    ]);
    const first = await loadClient(CLIENT, source);
    expect(first).toEqual({ ok: false, message: expect.stringContaining("answered 302") });
    expect((await loadClient(CLIENT, source)).ok).toBe(true);
  });

  it("names the host when the fetch fails", async () => {
    const result = await loadClient(CLIENT, {
      fetchDocument: async () => {
        throw new Error("timed out");
      },
    });
    expect(result).toEqual({ ok: false, message: expect.stringContaining("client.example") });
  });
});

describe("redirect URIs", () => {
  const registered = [
    "https://claude.ai/api/mcp/auth_callback",
    "http://127.0.0.1/callback",
    "http://localhost:3000/cb",
    "http://[::1]/cb",
  ];

  it("matches an https URI exactly", () => {
    expect(redirectUriMatches(registered, "https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(redirectUriMatches(registered, "https://claude.ai/api/mcp/auth_callback/")).toBe(false);
    expect(redirectUriMatches(registered, "https://claude.ai/api/mcp/auth_callback?x=1")).toBe(
      false,
    );
    expect(redirectUriMatches(registered, "https://claude.com/api/mcp/auth_callback")).toBe(false);
  });

  it("matches a loopback URI on any port", () => {
    expect(redirectUriMatches(registered, "http://127.0.0.1:53124/callback")).toBe(true);
    expect(redirectUriMatches(registered, "http://localhost:4000/cb")).toBe(true);
    expect(redirectUriMatches(registered, "http://[::1]:9000/cb")).toBe(true);
  });

  it("keeps the loopback host and path exact", () => {
    expect(redirectUriMatches(registered, "http://127.0.0.1:53124/other")).toBe(false);
    expect(redirectUriMatches(registered, "http://localhost:4000/callback")).toBe(false);
    expect(redirectUriMatches(registered, "http://127.0.0.2:53124/callback")).toBe(false);
  });

  it("knows a loopback redirect", () => {
    expect(isLoopbackRedirect("http://127.0.0.1:1/x")).toBe(true);
    expect(isLoopbackRedirect("https://127.0.0.1/x")).toBe(false);
    expect(isLoopbackRedirect("http://example.com/x")).toBe(false);
  });
});
