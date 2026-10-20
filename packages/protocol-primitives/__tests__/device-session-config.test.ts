/**
 * The discovery answer a device signs in with. It arrives over the network
 * from whatever address the person typed, so it is checked before any of it
 * reaches a sign-in request.
 */
import { describe, expect, it } from "vitest";
import { AUTH_CONFIG_ROUTE, fetchDeviceAuthConfig, parseDeviceAuthConfig } from "../src/index.js";

const GOOD = {
  region: "us-east-2",
  userPoolId: "us-east-2_VCdt366lt",
  deviceClientId: "4ai1rbsjq376jp43kst5bdpbg",
};

describe("parseDeviceAuthConfig", () => {
  it("reads a complete answer", () => {
    expect(parseDeviceAuthConfig(GOOD)).toEqual(GOOD);
  });

  it("refuses a pool from another region than the one named", () => {
    expect(parseDeviceAuthConfig({ ...GOOD, userPoolId: "us-east-1_VCdt366lt" })).toBeNull();
  });

  it("refuses a region that could steer the Cognito endpoint elsewhere", () => {
    expect(parseDeviceAuthConfig({ ...GOOD, region: "evil.example.com/x" })).toBeNull();
  });

  it("refuses a missing or malformed client id", () => {
    expect(parseDeviceAuthConfig({ ...GOOD, deviceClientId: "" })).toBeNull();
    expect(parseDeviceAuthConfig({ ...GOOD, deviceClientId: "a b" })).toBeNull();
    expect(parseDeviceAuthConfig({ region: GOOD.region, userPoolId: GOOD.userPoolId })).toBeNull();
  });

  it("refuses anything that is not an object", () => {
    expect(parseDeviceAuthConfig(null)).toBeNull();
    expect(parseDeviceAuthConfig("us-east-2")).toBeNull();
  });
});

describe("fetchDeviceAuthConfig", () => {
  it("asks the cloud's discovery route", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify(GOOD));
    }) as unknown as typeof fetch;

    expect(await fetchDeviceAuthConfig("https://d1.cloudfront.net/", fetchImpl)).toEqual(GOOD);
    expect(asked).toEqual([`https://d1.cloudfront.net${AUTH_CONFIG_ROUTE}`]);
  });

  it("says when the cloud cannot answer", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 404 })) as unknown as typeof fetch;
    await expect(fetchDeviceAuthConfig("https://d1.cloudfront.net", fetchImpl)).rejects.toThrow(
      /404/,
    );
  });
});
