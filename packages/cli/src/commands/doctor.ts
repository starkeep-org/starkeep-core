/**
 * `starkeep doctor`: check this computer's Starkeep setup and say how to fix
 * each problem.
 *
 * Each check ends `ok`, `warn` or `fail`. A failed check is one that stops a
 * command from working, and makes the doctor exit 1. A warning names
 * something that works but that the person likely wants to act on, such as a
 * cloud behind this checkout. Each check that does not pass prints the
 * command that fixes it.
 *
 * The cloud checks run only on a computer with a cloud, and never open a
 * browser: without an admin session they say how to sign in.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { adminSessionStatus } from "@starkeep/operator/admin-session";
import { callerIdentity } from "@starkeep/operator/bootstrap";
import { DAEMON_COMMANDS, daemonPort } from "@starkeep/operator/commands";
import { configFile, readConfig, regionFromUserPoolId } from "@starkeep/operator/config";
import { platformLine } from "@starkeep/operator/deployment-state";
import { repoRoot } from "@starkeep/operator/repo-root";
import { serviceStatus } from "@starkeep/operator/service-control";
import { cloudInstalled } from "../cloud";
import type { Command } from "../command";
import { CliError } from "../errors";
import type { Io } from "../io";
import { bootstrapState, readCloudState } from "./cloud";

export type CheckLevel = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  level: CheckLevel;
  detail: string;
  /** The command or step that fixes a warning or a failure. */
  fix?: string;
}

const ok = (name: string, detail: string): CheckResult => ({ name, level: "ok", detail });
const warn = (name: string, detail: string, fix: string): CheckResult => ({
  name,
  level: "warn",
  detail,
  fix,
});
const fail = (name: string, detail: string, fix: string): CheckResult => ({
  name,
  level: "fail",
  detail,
  fix,
});

function toolVersion(command: string): string | null {
  const r = spawnSync(command, ["--version"], { encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "").trim().split("\n")[0]! : null;
}

export function checkNode(version = process.versions.node): CheckResult {
  const major = Number(version.split(".")[0]);
  return major >= 24
    ? ok("Node", `Node ${version}`)
    : fail("Node", `Node ${version}; Starkeep needs Node 24 or later`, "nvm install 24");
}

export function checkTool(
  name: string,
  command: string,
  fix: string,
  version = toolVersion(command),
): CheckResult {
  return version ? ok(name, `${name} ${version}`) : fail(name, `no \`${command}\` on PATH`, fix);
}

/** Whether the workspace's install matches the checkout's commit and lockfile. */
export function checkInstall(root = repoRoot()): CheckResult {
  const record = join(root, "node_modules", ".starkeep-install.json");
  const fix = `pnpm install (in ${root})`;
  if (!existsSync(join(root, "node_modules"))) {
    return fail("Install", "the checkout's dependencies are not installed", fix);
  }
  let installed: { commit?: string; lockfile?: string };
  try {
    installed = JSON.parse(readFileSync(record, "utf8")) as typeof installed;
  } catch {
    return warn("Install", "no record of the last install, so its freshness is unknown", fix);
  }
  const commit = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  const head = commit.status === 0 ? commit.stdout.trim() : null;
  let lockfile: string | null = null;
  try {
    lockfile = createHash("sha256")
      .update(readFileSync(join(root, "pnpm-lock.yaml")))
      .digest("hex");
  } catch {
    // No lockfile: the comparison below reports it.
  }
  if (installed.commit !== head || installed.lockfile !== lockfile) {
    return warn(
      "Install",
      "the checkout changed since the last install, so the built packages may be stale",
      fix,
    );
  }
  return ok("Install", `installed at ${head?.slice(0, 8) ?? "?"}`);
}

/** Whether something holds `port` on loopback. */
export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => server.close(() => resolve(false)));
    server.listen(port, "127.0.0.1");
  });
}

/** Each service's port is either its own or free. */
export async function checkPorts(
  status: (id: string) => Promise<{ running: boolean }> = serviceStatus,
  inUse: (port: number) => Promise<boolean> = portInUse,
): Promise<CheckResult[]> {
  const ports: { id: string; name: string; port: number; envVar: string }[] = [
    {
      id: "local-data-server",
      name: "data-server",
      port: DAEMON_COMMANDS["local-data-server"].port ?? 9820,
      envVar: "STARKEEP_PORT",
    },
    {
      id: "drive",
      name: "drive",
      port: DAEMON_COMMANDS.drive.port ?? 9830,
      envVar: "STARKEEP_DRIVE_PORT",
    },
    {
      id: "admin-web",
      name: "admin-web",
      port: daemonPort("STARKEEP_ADMIN_PORT", 3000),
      envVar: "STARKEEP_ADMIN_PORT",
    },
  ];
  const results: CheckResult[] = [];
  for (const p of ports) {
    const label = `Port ${p.port}`;
    if ((await status(p.id)).running) {
      results.push(ok(label, `${p.name} runs on it`));
    } else if (await inUse(p.port)) {
      results.push(
        fail(
          label,
          `another program holds ${p.name}'s port`,
          `stop the program on port ${p.port} (lsof -i :${p.port}), or set ${p.envVar} to another port`,
        ),
      );
    } else {
      results.push(ok(label, `free for ${p.name}`));
    }
  }
  return results;
}

/** `config.json` parses, and a cloud's fields agree with each other. */
export function checkConfig(
  path = configFile(),
  read: () => Record<string, unknown> | null = readConfig,
): CheckResult {
  if (!existsSync(path)) return ok("config.json", "none yet; `starkeep setup` writes it");
  let config: Record<string, unknown> | null;
  try {
    config = read();
  } catch (err) {
    return fail(
      "config.json",
      `${path} does not parse: ${err instanceof Error ? err.message : String(err)}`,
      `fix the JSON in ${path}`,
    );
  }
  if (!config) return fail("config.json", `${path} does not parse`, `fix the JSON in ${path}`);
  const problems: string[] = [];
  if (typeof config.userPoolId === "string") {
    if (!regionFromUserPoolId(config.userPoolId)) problems.push("userPoolId names no region");
    for (const field of ["stackPrefix", "userPoolClientId", "identityPoolId"]) {
      if (typeof config[field] !== "string") problems.push(`a user pool but no ${field}`);
    }
  }
  if (typeof config.auroraEndpoint === "string" && typeof config.apiGatewayUrl !== "string") {
    problems.push("a database but no apiGatewayUrl");
  }
  if (problems.length > 0) {
    return fail(
      "config.json",
      problems.join("; "),
      "run `starkeep setup --cloud` again, which records the missing fields",
    );
  }
  return ok(
    "config.json",
    typeof config.userPoolId === "string"
      ? `names the cloud ${String(config.stackPrefix)} in ${regionFromUserPoolId(config.userPoolId)}`
      : "names no cloud",
  );
}

/** The checks that need a cloud: the admin session, the owner lane, skew and drift. */
export async function cloudChecks(io: Io): Promise<CheckResult[]> {
  const config = readConfig() ?? {};
  const results: CheckResult[] = [];
  const session = adminSessionStatus();
  results.push(
    session.signedIn
      ? ok("Admin session", `signed in as ${session.email ?? session.sub}`)
      : warn(
          "Admin session",
          "not signed in, so the cloud data server and Drive checks are skipped",
          "starkeep login --admin",
        ),
  );
  const region =
    typeof config.userPoolId === "string" ? regionFromUserPoolId(config.userPoolId) : undefined;
  if (region) {
    try {
      const identity = await callerIdentity(region);
      results.push(
        typeof config.accountId === "string" && identity.account !== config.accountId
          ? warn(
              "AWS credentials",
              `this terminal's credentials belong to ${identity.account}, not the cloud's ${config.accountId}`,
              `set AWS_PROFILE to a profile for ${config.accountId} before \`starkeep cloud bootstrap-update\``,
            )
          : ok("AWS credentials", `account ${identity.account}, for the bootstrap stack`),
      );
    } catch {
      results.push(
        warn(
          "AWS credentials",
          "this terminal has no AWS credentials; only the bootstrap stack needs them",
          "aws sso login, or set AWS_PROFILE",
        ),
      );
    }
    const bootstrap = await bootstrapState().catch(
      (err: Error) => ({ kind: "unknown", reason: err.message }) as const,
    );
    if (bootstrap.kind === "read" && bootstrap.changes !== "no-changes") {
      results.push(
        warn(
          "Bootstrap stack",
          `${bootstrap.changes} change(s) from this checkout's template`,
          "starkeep cloud bootstrap-update",
        ),
      );
    } else if (bootstrap.kind === "read") {
      results.push(ok("Bootstrap stack", "matches this checkout's template"));
    }
  }
  if (!session.signedIn || !cloudInstalled()) return results;
  try {
    // A doctor run is no cloud action: it leaves the session's idle time alone.
    const state = await readCloudState(io, { signIn: false, markUsed: false });
    if (!state) return results;
    const kind = state.platform.kind;
    const line = platformLine(state.platform);
    if (kind === "current" || kind === "outside-git") results.push(ok("Cloud data server", line));
    else if (kind === "ahead" || kind === "diverged" || kind === "unknown-commit")
      results.push(
        warn("Cloud data server", line, "check out the branch the cloud runs before you redeploy"),
      );
    else results.push(warn("Cloud data server", line, "starkeep update --platform"));
    if (state.drive === false)
      results.push(warn("Drive", "behind this checkout", "starkeep update --platform"));
  } catch (err) {
    results.push(
      warn(
        "Cloud",
        `could not read the cloud: ${err instanceof Error ? err.message : String(err)}`,
        "starkeep login --admin",
      ),
    );
  }
  return results;
}

const MARK: Record<CheckLevel, string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };

export const doctorCommand: Command = {
  name: "doctor",
  summary: "Check this computer's Starkeep setup and say how to fix each problem",
  usage: "",
  lane: "check",
  flags: {},
  details:
    "Checks Node, pnpm and git, the checkout's install, the services' ports and config.json.\n" +
    "On a computer with a cloud, also checks the admin session, this terminal's AWS\n" +
    "credentials, the bootstrap stack's drift and the cloud data server's skew. A failed\n" +
    "check makes the command exit 1; a warning does not. The cloud checks never open a browser,\n" +
    "and they leave the admin session's idle time alone.",
  async run(io) {
    const results: CheckResult[] = [
      checkNode(),
      checkTool("pnpm", "pnpm", "npm install -g pnpm@10"),
      checkTool("git", "git", "install git from https://git-scm.com"),
      checkInstall(),
      ...(await checkPorts()),
      checkConfig(),
      ...(typeof readConfig()?.userPoolId === "string" ? await cloudChecks(io) : []),
    ];
    const failed = results.filter((r) => r.level === "fail").length;
    const warned = results.filter((r) => r.level === "warn").length;
    if (!io.json) {
      const width = Math.max(...results.map((r) => r.name.length)) + 2;
      for (const r of results) {
        io.print(`${MARK[r.level]}  ${r.name.padEnd(width)}${r.detail}`);
        if (r.fix) io.print(`      ${"".padEnd(width)}Fix: ${r.fix}`);
      }
      io.print();
      io.print(
        failed === 0 && warned === 0
          ? "Everything checks out."
          : `${failed} failed, ${warned} warning(s).`,
      );
    }
    if (failed > 0) {
      throw new CliError(`${failed} check(s) failed.`, 1, "CHECKS_FAILED", undefined, {
        checks: results,
      });
    }
    io.event({ type: "result", ok: true, data: { checks: results } });
  },
};
