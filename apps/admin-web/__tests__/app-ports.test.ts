/**
 * Each installed local app keeps one port, and so one browser origin, until
 * it is reinstalled (#135).
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_APP_PORT_RANGE,
  appPort,
  appPortRangeFromEnv,
  hashedPort,
} from "../src/lib/app-ports";

const RANGE = DEFAULT_APP_PORT_RANGE;
const INSTANCE = "9820";
const base = { range: RANGE, instance: INSTANCE };
const hash = (appId: string) => hashedPort(appId, INSTANCE, RANGE);

function recordFile(): string {
  return join(mkdtempSync(join(tmpdir(), "app-ports-")), "app-ports.json");
}

/** A port checker that reports `busy` ports as held and every other port as free. */
function busy(...ports: number[]) {
  const held = new Set(ports);
  return async (port: number) => !held.has(port);
}

/** An app id whose hash port is `port`. */
function idHashingTo(port: number): string {
  for (let i = 0; ; i++) if (hash(`app-${i}`) === port) return `app-${i}`;
}

/** The port of a successful outcome; fails the test on any other outcome. */
function okPort(outcome: Awaited<ReturnType<typeof appPort>>): number {
  expect(outcome).toEqual({ ok: true, port: expect.any(Number) });
  return (outcome as { port: number }).port;
}

/** The port after `port` in the range, wrapping at its end. */
const nextInRange = (port: number) => (port === RANGE.last ? RANGE.first : port + 1);

const record = (file: string) =>
  JSON.parse(readFileSync(file, "utf-8")) as {
    apps: Record<string, { port: number; installedAt?: string }>;
    retired: number[];
  };

describe("appPort", () => {
  it("gives an app the hash of its id first, inside the range", async () => {
    const file = recordFile();
    const port = hash("dice");
    expect(port).toBeGreaterThanOrEqual(RANGE.first);
    expect(port).toBeLessThanOrEqual(RANGE.last);
    expect(await appPort("dice", "t1", { ...base, file, isFree: busy() })).toEqual({
      ok: true,
      port,
    });
  });

  it("reuses the recorded port on later starts of the same install", async () => {
    const file = recordFile();
    const first = await appPort("dice", "t1", { ...base, file, isFree: busy() });
    const again = await appPort("dice", "t1", { ...base, file, isFree: busy() });
    expect(again).toEqual(first);
  });

  it("moves past a held hash port once, and keeps the port it moved to", async () => {
    const file = recordFile();
    const hashPort = hash("dice");
    const first = okPort(await appPort("dice", "t1", { ...base, file, isFree: busy(hashPort) }));
    expect(first).toBe(nextInRange(hashPort));
    // The hash port is free now; the app stays where it was recorded.
    expect(okPort(await appPort("dice", "t1", { ...base, file, isFree: busy() }))).toBe(first);
  });

  it("refuses to start, asking whether the app already runs there, when its recorded port is held", async () => {
    const file = recordFile();
    const port = okPort(await appPort("dice", "t1", { ...base, file, isFree: busy() }));
    const out = await appPort("dice", "t1", { ...base, file, isFree: busy(port) });
    expect(out).toEqual({
      ok: false,
      reason: "port-in-use",
      port,
      error: `'dice' cannot start: its port ${port} is in use. Is 'dice' already running at http://localhost:${port}?`,
    });
    expect(record(file).apps.dice!.port).toBe(port);
  });

  it("gives a reinstalled app a new port and never hands the old one out again", async () => {
    const file = recordFile();
    const old = okPort(await appPort("dice", "t1", { ...base, file, isFree: busy() }));
    const reinstalled = okPort(await appPort("dice", "t2", { ...base, file, isFree: busy() }));
    expect(reinstalled).not.toBe(old);
    expect(record(file).retired).toEqual([old]);
    expect(record(file).apps.dice).toEqual({ port: reinstalled, installedAt: "t2" });

    // Another app whose hash lands on the retired port skips it.
    const other = idHashingTo(old);
    const next = okPort(await appPort(other, "t3", { ...base, file, isFree: busy() }));
    expect(next).not.toBe(old);
  });

  it("moves an app off a held recorded port on request, and retires the old port", async () => {
    const file = recordFile();
    const old = okPort(await appPort("dice", "t1", { ...base, file, isFree: busy() }));
    const moved = okPort(
      await appPort("dice", "t1", { ...base, file, isFree: busy(old), reassign: true }),
    );
    expect(moved).toBe(nextInRange(old));
    expect(record(file)).toEqual({
      apps: { dice: { port: moved, installedAt: "t1" } },
      retired: [old],
    });

    // The old port is free again, but the app stays on the port it moved to,
    // and no other app gets the old port.
    expect(okPort(await appPort("dice", "t1", { ...base, file, isFree: busy() }))).toBe(moved);
    const other = idHashingTo(old);
    expect(okPort(await appPort(other, "t2", { ...base, file, isFree: busy() }))).not.toBe(old);
  });

  it("gives an app with no recorded port its usual first port on a reassign", async () => {
    const file = recordFile();
    const out = await appPort("dice", "t1", { ...base, file, isFree: busy(), reassign: true });
    expect(out).toEqual({ ok: true, port: hash("dice") });
    expect(record(file).retired).toEqual([]);
  });

  it("keeps the port when the registry cannot say which install is running", async () => {
    const file = recordFile();
    const first = okPort(await appPort("dice", "t1", { ...base, file, isFree: busy() }));
    expect(okPort(await appPort("dice", undefined, { ...base, file, isFree: busy() }))).toBe(first);
    expect(record(file).retired).toEqual([]);
  });

  it("adopts the install time for a port recorded before the app was installed", async () => {
    const file = recordFile();
    const first = okPort(await appPort("dice", undefined, { ...base, file, isFree: busy() }));
    expect(okPort(await appPort("dice", "t1", { ...base, file, isFree: busy() }))).toBe(first);
    expect(record(file).apps.dice!.installedAt).toBe("t1");
  });

  it("gives concurrent first starts of two apps two different ports", async () => {
    const file = recordFile();
    // Two ids with the same hash port race for it.
    const other = idHashingTo(hash("dice"));
    const [a, b] = await Promise.all([
      appPort("dice", "t1", { ...base, file, isFree: busy() }),
      appPort(other, "t1", { ...base, file, isFree: busy() }),
    ]);
    expect(okPort(a)).not.toBe(okPort(b));
    expect(Object.keys(record(file).apps).sort()).toEqual([other, "dice"].sort());
  });

  it("starts a second instance's copy of an app on a different port", () => {
    expect(hashedPort("photos", "9820", RANGE)).not.toBe(hashedPort("photos", "9822", RANGE));
  });

  it("allocates inside a custom range", async () => {
    const file = recordFile();
    const range = { first: 30000, last: 30009 };
    const port = okPort(
      await appPort("dice", "t1", { file, range, instance: INSTANCE, isFree: busy() }),
    );
    expect(port).toBeGreaterThanOrEqual(30000);
    expect(port).toBeLessThanOrEqual(30009);
  });

  it("skips ports that browsers refuse to load", async () => {
    const file = recordFile();
    const range = { first: 6000, last: 6001 };
    const out = await appPort("dice", "t1", { file, range, instance: INSTANCE, isFree: busy() });
    expect(out).toEqual({ ok: true, port: 6001 });
  });

  describe("under a malformed range variable", () => {
    const withRange = async (value: string, body: () => Promise<void>) => {
      const prior = process.env.STARKEEP_APP_PORT_RANGE;
      process.env.STARKEEP_APP_PORT_RANGE = value;
      try {
        await body();
      } finally {
        if (prior === undefined) delete process.env.STARKEEP_APP_PORT_RANGE;
        else process.env.STARKEEP_APP_PORT_RANGE = prior;
      }
    };
    const rangeError = (appPortRangeFromEnv("21999-21000") as { error: string }).error;

    it("refuses a first start, naming the variable", async () => {
      const file = recordFile();
      expect(rangeError).toContain("STARKEEP_APP_PORT_RANGE");
      await withRange("21999-21000", async () => {
        const out = await appPort("dice", "t1", { file, instance: INSTANCE, isFree: busy() });
        expect(out).toEqual({ ok: false, error: rangeError });
      });
    });

    it("still starts an app on its recorded port", async () => {
      const file = recordFile();
      const port = okPort(await appPort("dice", "t1", { ...base, file, isFree: busy() }));
      await withRange("21999-21000", async () => {
        const out = await appPort("dice", "t1", { file, instance: INSTANCE, isFree: busy() });
        expect(out).toEqual({ ok: true, port });
      });
    });

    it("refuses a reassign and keeps the recorded port", async () => {
      const file = recordFile();
      const port = okPort(await appPort("dice", "t1", { ...base, file, isFree: busy() }));
      await withRange("21999-21000", async () => {
        const out = await appPort("dice", "t1", {
          file,
          instance: INSTANCE,
          isFree: busy(port),
          reassign: true,
        });
        expect(out).toEqual({ ok: false, error: rangeError });
      });
      expect(record(file)).toEqual({ apps: { dice: { port, installedAt: "t1" } }, retired: [] });
    });
  });
});

describe("appPortRangeFromEnv", () => {
  it("reads first-last, and falls back to the default when unset", () => {
    expect(appPortRangeFromEnv("21000-21999")).toEqual({ first: 21000, last: 21999 });
    expect(appPortRangeFromEnv(" 21000 - 21999 ")).toEqual({ first: 21000, last: 21999 });
    expect(appPortRangeFromEnv(undefined)).toEqual(DEFAULT_APP_PORT_RANGE);
    expect(appPortRangeFromEnv("")).toEqual(DEFAULT_APP_PORT_RANGE);
  });

  it("rejects a range that is reversed, privileged, too high or not two numbers", () => {
    for (const bad of ["21999-21000", "80-1000", "60000-70000", "21000", "a-b"]) {
      expect("error" in appPortRangeFromEnv(bad)).toBe(true);
    }
  });
});
