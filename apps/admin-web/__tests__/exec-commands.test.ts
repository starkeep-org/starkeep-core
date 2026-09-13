/**
 * Workspace-daemon ports must be read from the same env var the daemon itself
 * reads. admin-web spawns these daemons as children, so they inherit its env: a
 * port hardcoded here would disagree with the port the daemon actually binds,
 * and the daemon route would then probe the wrong port (reporting not-running)
 * and spawn a duplicate on top of a healthy instance.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";

const PORT_VARS = ["STARKEEP_PORT", "STARKEEP_DRIVE_PORT"] as const;
const saved = new Map(PORT_VARS.map((k) => [k, process.env[k]]));

async function loadDaemonCommands(env: Partial<Record<(typeof PORT_VARS)[number], string>>) {
  for (const key of PORT_VARS) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // The module reads env at load time, so each case needs a fresh copy.
  vi.resetModules();
  return await import("../src/lib/exec-commands");
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("workspace daemon ports", () => {
  it("fall back to the documented defaults when the env is unset", async () => {
    const { DAEMON_COMMANDS: commands } = await loadDaemonCommands({});
    expect(commands["local-data-server"].port).toBe(9820);
    expect(commands.drive.port).toBe(9830);
  });

  it("follow STARKEEP_PORT — the data server's own knob", async () => {
    const { DAEMON_COMMANDS: commands } = await loadDaemonCommands({ STARKEEP_PORT: "9821" });
    expect(commands["local-data-server"].port).toBe(9821);
    // Independent knobs: one daemon's override must not move the other's.
    expect(commands.drive.port).toBe(9830);
  });

  it("follow STARKEEP_DRIVE_PORT, which drive's package script also reads", async () => {
    const { DAEMON_COMMANDS: commands } = await loadDaemonCommands({ STARKEEP_DRIVE_PORT: "9831" });
    expect(commands.drive.port).toBe(9831);
    expect(commands["local-data-server"].port).toBe(9820);
  });

  it("ignore an unparseable value rather than recording NaN", async () => {
    const { DAEMON_COMMANDS: commands } = await loadDaemonCommands({ STARKEEP_PORT: "", STARKEEP_DRIVE_PORT: "nope" });
    expect(commands["local-data-server"].port).toBe(9820);
    expect(commands.drive.port).toBe(9830);
  });
});

/**
 * Gap 4 of the Drive phase: the daemon command and the package script it names
 * were two copies of one fact with no test between them. A rename on either
 * side surfaced as "daemon exited during startup" with pnpm's own error in the
 * log, which names the script but not the caller that asked for it.
 */
describe("workspace daemon commands name a script that exists", () => {
  const packageFor: Record<string, string> = {
    "@starkeep/local-data-server": "../../local-data-server/package.json",
    "@starkeep/drive": "../../drive/package.json",
  };

  it.each(Object.keys(packageFor))("%s", async (workspace) => {
    const { DAEMON_COMMANDS } = await loadDaemonCommands({});
    const command = Object.values(DAEMON_COMMANDS).find((c) =>
      c.args.includes(workspace),
    );
    expect(command, `no daemon spawns ${workspace}`).toBeDefined();

    // `pnpm --filter <workspace> <script>` — the script is the last argument.
    const [pnpm, filter, named, script, ...rest] = command!.args;
    expect([pnpm, filter, named]).toEqual(["pnpm", "--filter", workspace]);
    expect(rest).toEqual([]);

    const scripts = JSON.parse(
      readFileSync(new URL(packageFor[workspace], import.meta.url), "utf-8"),
    ).scripts as Record<string, string>;
    expect(Object.keys(scripts)).toContain(script);

    // And it must start the app rather than a development server. A daemon the
    // operator starts from the Dashboard is the product, not a compile-on-
    // demand harness — which is the whole of what the Vite migration bought.
    expect(scripts[script]).not.toMatch(/\bdev\b|--watch/);
  });
});
