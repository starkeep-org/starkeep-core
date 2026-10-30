/**
 * Where Drive reaches the local-data-server.
 *
 * admin-web spawns Drive with its own environment, so Drive follows the same
 * port variable the data server listens on. A second Starkeep instance on this
 * machine sets `STARKEEP_PORT`, and its Drive must reach that instance's data
 * server rather than the default one on 9820. The e2e harness sets the full URL,
 * which wins.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

async function ldsUrl(): Promise<string> {
  // `LDS_URL` is read when the module loads, so each case loads a fresh copy.
  vi.resetModules();
  return (await import("../src/lib/drive-client")).LDS_URL;
}

afterEach(() => {
  delete process.env.STARKEEP_PORT;
  delete process.env.STARKEEP_LOCAL_DATA_SERVER_URL;
});

describe("the local-data-server address", () => {
  it("defaults to the loopback port 9820", async () => {
    expect(await ldsUrl()).toBe("http://127.0.0.1:9820");
  });

  it("follows STARKEEP_PORT, the port admin-web spawns the data server on", async () => {
    process.env.STARKEEP_PORT = "9821";
    expect(await ldsUrl()).toBe("http://127.0.0.1:9821");
  });

  it("lets an explicit URL win over the port", async () => {
    process.env.STARKEEP_PORT = "9821";
    process.env.STARKEEP_LOCAL_DATA_SERVER_URL = "http://127.0.0.1:41111";
    expect(await ldsUrl()).toBe("http://127.0.0.1:41111");
  });
});
