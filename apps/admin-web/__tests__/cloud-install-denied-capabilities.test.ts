/**
 * POST /api/apps/[appId]/cloud-install — the operator-consent hand-off.
 *
 * The consent decision made in the UI reaches the installer through exactly one
 * channel: the `STARKEEP_DENIED_CAPABILITIES` env var on the spawned CLI. If
 * this forwarding breaks, a denied capability is installed anyway and nothing
 * else in the system notices. `child_process.spawn` is mocked so the env is
 * observable without running an install.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { NextRequest } from "next/server";

interface SpawnCall {
  command: string;
  args: string[];
  options: { env: Record<string, string | undefined>; cwd?: string };
}

const spawnCalls: SpawnCall[] = [];
let currentChild: FakeChild | null = null;

/** Minimal ChildProcess stand-in: pipes plus the close/error events the route
 * listens on. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter() as EventEmitter & { pipe: () => void };
  stderr = new EventEmitter() as EventEmitter & { pipe: () => void };
  constructor() {
    super();
    this.stdout.pipe = () => {};
    this.stderr.pipe = () => {};
  }
  finish(code: number): void {
    this.emit("close", code);
  }
}

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[], options: SpawnCall["options"]) => {
    spawnCalls.push({ command, args, options });
    currentChild = new FakeChild();
    return currentChild;
  },
}));

const CREDS = {
  accessKeyId: "AKIA",
  secretAccessKey: "secret",
  sessionToken: "token",
  region: "us-east-1",
};

let POST: (req: NextRequest, ctx: { params: Promise<{ appId: string }> }) => Promise<Response>;

function req(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

/** Drive the route far enough to spawn, then let the child exit cleanly. */
async function install(body: unknown, appId = "photos"): Promise<void> {
  const res = await POST(req(body), { params: Promise.resolve({ appId }) });
  const reader = (res.body as ReadableStream).getReader();
  const drained = (async () => {
    // Read until the stream closes (the route closes it on child exit).
    for (;;) {
      const { done } = await reader.read();
      if (done) return;
    }
  })();
  currentChild!.finish(0);
  await drained;
}

beforeAll(async () => {
  process.env.STARKEEP_DIR = process.env.STARKEEP_DIR ?? "/tmp/adminweb-cloud-install-test";
  ({ POST } = await import("../app/api/apps/[appId]/cloud-install/route"));
});

beforeEach(() => {
  spawnCalls.length = 0;
  currentChild = null;
  delete process.env.STARKEEP_DENIED_CAPABILITIES;
});

function envOf(n = 0): Record<string, string | undefined> {
  return spawnCalls[n]!.options.env;
}

describe("credential validation", () => {
  it("400s without spawning when a credential field is missing", async () => {
    for (const drop of ["accessKeyId", "secretAccessKey", "sessionToken", "region"] as const) {
      const body: Record<string, unknown> = { ...CREDS };
      delete body[drop];
      const res = await POST(req(body), { params: Promise.resolve({ appId: "photos" }) });
      expect(res.status, drop).toBe(400);
    }
    expect(spawnCalls).toHaveLength(0);
  });
});

describe("STARKEEP_DENIED_CAPABILITIES forwarding (plan §3.2)", () => {
  it("forwards the operator's denied set as a comma-separated env var", async () => {
    await install({ ...CREDS, deniedCapabilities: ["bedrock.invoke", "some.other"] });
    expect(envOf().STARKEEP_DENIED_CAPABILITIES).toBe("bedrock.invoke,some.other");
  });

  it("forwards a single denied capability", async () => {
    await install({ ...CREDS, deniedCapabilities: ["bedrock.invoke"] });
    expect(envOf().STARKEEP_DENIED_CAPABILITIES).toBe("bedrock.invoke");
  });

  it("sets NO env var when the operator denied nothing", async () => {
    await install({ ...CREDS, deniedCapabilities: [] });
    // An empty string would be indistinguishable from "unset" downstream, but
    // leaving the key off entirely is unambiguous.
    expect("STARKEEP_DENIED_CAPABILITIES" in envOf()).toBe(false);
  });

  it("sets no env var when the field is absent altogether", async () => {
    await install(CREDS);
    expect("STARKEEP_DENIED_CAPABILITIES" in envOf()).toBe(false);
  });

  it("does not leak a denial from a previous request into the next install", async () => {
    await install({ ...CREDS, deniedCapabilities: ["bedrock.invoke"] });
    await install(CREDS);
    expect(envOf(0).STARKEEP_DENIED_CAPABILITIES).toBe("bedrock.invoke");
    expect("STARKEEP_DENIED_CAPABILITIES" in envOf(1)).toBe(false);
  });

  it("passes the operator's STS credentials and region alongside", async () => {
    await install({ ...CREDS, deniedCapabilities: ["bedrock.invoke"] });
    expect(envOf()).toMatchObject({
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "token",
      AWS_REGION: "us-east-1",
    });
  });

  it("spawns the app installer CLI for the requested app, non-interactively", async () => {
    await install({ ...CREDS, deniedCapabilities: ["bedrock.invoke"] }, "notes");
    expect(spawnCalls[0]!.args).toEqual([
      "--filter",
      "@starkeep/admin-installer",
      "cli:install-app",
      "notes",
      "--non-interactive",
    ]);
  });
});
