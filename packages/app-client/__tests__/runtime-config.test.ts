/**
 * The runtime config an app serves its browser half: the consent pages'
 * URLs on the gateway's own host, beside the browser-facing base.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeConfigHandler, getRuntimeConfig } from "../src/runtime-config";

const GATEWAY = "https://abc.execute-api.us-east-1.amazonaws.com";
const EDGE = "https://d111.cloudfront.net";
const saved = { ...process.env };

/** The variables the installer sets on a cloud app's handler. */
function cloud(over: Record<string, string | undefined> = {}): void {
  const env: Record<string, string | undefined> = {
    STARKEEP_APP_ID: "probe",
    STARKEEP_CLOUD_DATA_BASE: GATEWAY,
    STARKEEP_API_GATEWAY_URL: EDGE,
    ...over,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  process.env = { ...saved };
});

describe("getRuntimeConfig: the consent pages", () => {
  it("names the connect and connections pages on the gateway's own host, not the browser-facing base", () => {
    cloud();
    const cfg = getRuntimeConfig();
    expect(cfg.connectUrl).toBe(`${GATEWAY}/connect?app=probe`);
    expect(cfg.connectionsUrl).toBe(`${GATEWAY}/connections`);
    expect(cfg.apiGatewayUrl).toBe(EDGE);
  });

  it("drops a trailing slash from the gateway URL", () => {
    cloud({ STARKEEP_CLOUD_DATA_BASE: `${GATEWAY}/` });
    const cfg = getRuntimeConfig();
    expect(cfg.connectUrl).toBe(`${GATEWAY}/connect?app=probe`);
    expect(cfg.connectionsUrl).toBe(`${GATEWAY}/connections`);
  });

  it("encodes the app id in the connect page's query", () => {
    cloud({ STARKEEP_APP_ID: "a&b c" });
    expect(getRuntimeConfig().connectUrl).toBe(`${GATEWAY}/connect?app=a%26b%20c`);
  });

  it("names neither page on the local surface, which sets no gateway URL", () => {
    cloud({ STARKEEP_CLOUD_DATA_BASE: undefined, STARKEEP_API_GATEWAY_URL: undefined });
    const cfg = getRuntimeConfig();
    expect(cfg.connectUrl).toBeUndefined();
    expect(cfg.connectionsUrl).toBeUndefined();
  });

  it("names neither page without an app id", () => {
    cloud({ STARKEEP_APP_ID: undefined });
    const cfg = getRuntimeConfig();
    expect(cfg.connectUrl).toBeUndefined();
    expect(cfg.connectionsUrl).toBeUndefined();
  });

  it("serves both URLs from the handler", async () => {
    cloud();
    const body = (await createRuntimeConfigHandler()().json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      connectUrl: `${GATEWAY}/connect?app=probe`,
      connectionsUrl: `${GATEWAY}/connections`,
    });
  });
});
