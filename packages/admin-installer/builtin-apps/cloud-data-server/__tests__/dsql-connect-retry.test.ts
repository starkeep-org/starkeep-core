/**
 * What the broker does when DSQL refuses an app's login.
 *
 * SQLSTATE 28000 has two causes and one shape. A mapping that has not
 * propagated yet clears on its own, so waiting is the cure. A session assumed
 * from an IAM role that has since been deleted and recreated — which is what a
 * keep-data uninstall followed by a reinstall does to every app — never clears
 * while the session lives, so waiting is not a cure and re-assuming the role
 * is. The factory could not tell them apart and waited out its whole budget on
 * both, which is how one warm Lambda container answered every sync exchange
 * with a 500 for the two minutes a live Tier-3 run spent waiting for rows that
 * were sitting in the cloud (`findings-step27-refill-from-cloud-2026-09-19.md`).
 *
 * These cases drive the real retry policy with a faked connect, so no cluster
 * and no STS are involved.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppCredsProvider } from "../src/api-handler.js";

let AppDsqlClientFactory: (typeof import("../src/api-handler.js"))["AppDsqlClientFactory"];
let DsqlConnectDeniedError: (typeof import("../src/api-handler.js"))["DsqlConnectDeniedError"];
let setDsqlConnect: (typeof import("../src/api-handler.js"))["__setDsqlConnectForTests"];

beforeAll(async () => {
  process.env.STACK_PREFIX = "teststack";
  process.env.AWS_REGION = "us-east-1";
  ({
    AppDsqlClientFactory,
    DsqlConnectDeniedError,
    __setDsqlConnectForTests: setDsqlConnect,
  } = await import("../src/api-handler.js"));
});

afterEach(() => {
  setDsqlConnect(null);
  vi.restoreAllMocks();
});

const connectOptions = { hostname: "cluster.test.localdomain", region: "us-east-1" };

/**
 * The retry loop's backoff, removed.
 *
 * What is under test is the policy — how many attempts it makes, and which of
 * them presents a freshly assumed session — and the eleven seconds the real
 * backoff spends proving it are eleven seconds of nothing happening.
 */
const noWait = async (): Promise<void> => {};

/** SQLSTATE 28000 as the pg driver surfaces it on a refused connect. */
function refused(): Error & { code: string } {
  return Object.assign(new Error("unable to accept connection, access denied"), {
    code: "28000",
  });
}

/**
 * A credentials provider whose sessions are distinguishable, so a test can say
 * which one a given connect attempt presented.
 */
function sessions(): { provider: AppCredsProvider; issued: string[]; asked: boolean[] } {
  const issued: string[] = [];
  const asked: boolean[] = [];
  let n = 0;
  let current = `session-${++n}`;
  issued.push(current);
  const provider: AppCredsProvider = async (options) => {
    asked.push(options?.forceRefresh === true);
    if (options?.forceRefresh) {
      current = `session-${++n}`;
      issued.push(current);
    }
    return {
      accessKeyId: current,
      secretAccessKey: "secret",
      sessionToken: "token",
      expiresAt: Date.now() + 15 * 60_000,
    };
  };
  return { provider, issued, asked };
}

describe("the DSQL connect retry", () => {
  it("re-assumes the app role after the first refusal, and connects on the new session", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { provider, asked } = sessions();
    const presented: string[] = [];
    setDsqlConnect(async ({ creds }) => {
      presented.push(creds.accessKeyId);
      // The stale session is refused; anything minted after it is accepted.
      if (creds.accessKeyId === "session-1") throw refused();
      return { end: async () => {}, on: () => {} } as never;
    });

    const factory = new AppDsqlClientFactory("probe", provider, "teststack", noWait);
    await factory.createClient(connectOptions);

    expect(presented).toEqual(["session-1", "session-2"]);
    // Asked once without a refresh, then once with one. Nothing else.
    expect(asked).toEqual([false, true]);
  });

  it("asks for a fresh session once, not on every attempt", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { provider, asked, issued } = sessions();
    let attempts = 0;
    setDsqlConnect(async () => {
      attempts += 1;
      // Refused three times regardless of the session — propagation, not a
      // dead principal — then authorized.
      if (attempts <= 3) throw refused();
      return { end: async () => {}, on: () => {} } as never;
    });

    const factory = new AppDsqlClientFactory("probe", provider, "teststack", noWait);
    await factory.createClient(connectOptions);

    expect(attempts).toBe(4);
    expect(asked.filter(Boolean)).toHaveLength(1);
    expect(issued).toEqual(["session-1", "session-2"]);
  });

  it("gives up with a named error rather than a bare failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { provider } = sessions();
    setDsqlConnect(async () => {
      throw refused();
    });

    const factory = new AppDsqlClientFactory("probe", provider, "teststack", noWait);
    await expect(factory.createClient(connectOptions)).rejects.toBeInstanceOf(
      DsqlConnectDeniedError,
    );
  });

  it("does not retry, and does not re-assume, on a failure that is not an auth denial", async () => {
    const { provider, asked } = sessions();
    let attempts = 0;
    setDsqlConnect(async () => {
      attempts += 1;
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    });

    const factory = new AppDsqlClientFactory("probe", provider, "teststack", noWait);
    await expect(factory.createClient(connectOptions)).rejects.toThrow("ECONNREFUSED");
    expect(attempts).toBe(1);
    expect(asked).toEqual([false]);
  });
});
