/**
 * GET /api/runtime-config — how the browser learns where the daemons are.
 *
 * The UI calls the local-data-server and links to Drive directly. On a real
 * install those are loopback defaults; in a harness-booted stack they are
 * ephemeral ports. This route is the only thing standing between the two, so a
 * default that stopped matching the API routes' own default would put the
 * browser on a different data server from the server side of the same app.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

async function freshRoute(): Promise<{ GET: () => Response }> {
  // The handler reads env per request, but the module is re-imported anyway so
  // a future capture-at-load would not quietly pass this suite.
  vi.resetModules();
  return (await import("../src/routes/runtime-config")) as { GET: () => Response };
}

afterEach(() => {
  delete process.env.STARKEEP_LOCAL_DATA_SERVER_URL;
  delete process.env.STARKEEP_DRIVE_URL;
});

describe("with no environment set", () => {
  it("serves the loopback defaults the API routes themselves fall back to", async () => {
    const { GET } = await freshRoute();
    expect(await GET().json()).toEqual({
      localDataServerUrl: "http://127.0.0.1:9820",
      driveUrl: "http://localhost:9830",
    });
  });
});

describe("under a harness-booted stack", () => {
  it("serves the ports the harness actually allocated", async () => {
    process.env.STARKEEP_LOCAL_DATA_SERVER_URL = "http://127.0.0.1:41111";
    process.env.STARKEEP_DRIVE_URL = "http://localhost:41222";
    const { GET } = await freshRoute();
    expect(await GET().json()).toEqual({
      localDataServerUrl: "http://127.0.0.1:41111",
      driveUrl: "http://localhost:41222",
    });
  });

  it("answers JSON", async () => {
    const { GET } = await freshRoute();
    expect(GET().headers.get("content-type")).toContain("application/json");
  });
});
