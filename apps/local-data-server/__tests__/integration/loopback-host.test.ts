/**
 * The server answers loopback names only, so a DNS-rebinding page cannot read
 * its answers as its own. A rebinding page's requests carry the attacker's
 * domain in `Host`, and a same-origin GET carries no `Origin` for the
 * per-route refusals to see.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request } from "node:http";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import { hostnameOf, isLoopbackHost } from "../../loopback-host.js";

describe("isLoopbackHost", () => {
  it("accepts this machine's loopback names, with or without a port", () => {
    for (const host of [
      "localhost",
      "localhost:4000",
      "127.0.0.1:4000",
      "[::1]:4000",
      "LOCALHOST:4000",
    ]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it("refuses any other name, including one that starts like a loopback name", () => {
    for (const host of [
      "attacker.example:4000",
      "localhost.attacker.example",
      "127.0.0.1.nip.io:4000",
      "192.168.1.5:4000",
    ]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it("passes a request with no Host, which no browser sends", () => {
    expect(isLoopbackHost(undefined)).toBe(true);
  });

  it("reads the hostname out of a Host header", () => {
    expect(hostnameOf("[::1]:4000")).toBe("[::1]");
    expect(hostnameOf("Example.COM:80")).toBe("example.com");
  });
});

describe("the server's Host check", () => {
  let server: LocalDataServer;

  beforeAll(async () => {
    server = await startLocalDataServer();
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
  });

  /** A GET with a chosen Host header, which `fetch` will not send. */
  function getWithHost(path: string, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: server.port, path, headers: { Host: host } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("answers a loopback Host", async () => {
    expect(await getWithHost("/auth/status", `localhost:${server.port}`)).toBe(200);
    expect(await getWithHost("/auth/status", `127.0.0.1:${server.port}`)).toBe(200);
  });

  it("refuses a rebinding page's Host on a loopback-authorized read", async () => {
    expect(await getWithHost("/auth/status", `attacker.example:${server.port}`)).toBe(403);
    expect(await getWithHost("/config", `attacker.example:${server.port}`)).toBe(403);
  });
});
