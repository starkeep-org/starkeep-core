#!/usr/bin/env node
/**
 * The `starkeep` command: `pnpm starkeep <command>` in the checkout, or
 * `starkeep <command>` through the `~/.local/bin/starkeep` link that setup
 * offers.
 *
 * The CLI itself is TypeScript in `packages/cli` and needs the workspace's
 * dependencies, which a fresh clone does not have yet. This wrapper uses Node
 * built-ins only, so it runs before any install. It:
 *
 * 1. Checks for Node 24 or later and a `pnpm` command on PATH.
 * 2. Runs `pnpm install` from the checkout root for `setup`, for any
 *    command when the install has never run, and under `--install-first`. The root `postinstall` builds the
 *    workspace.
 * 3. Warns when the checkout's commit or lockfile changed since the last
 *    install, because the built packages may then be stale.
 * 4. Runs the CLI under tsx, in the person's own folder.
 *
 * pnpm runs a root script from the checkout root and records the person's
 * folder in `INIT_CWD`. The CLI runs there, and receives it as `STARKEEP_CWD`,
 * so `pnpm starkeep install --local ./my-app` means the folder the person
 * typed it in.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The real path, so the `~/.local/bin/starkeep` link still finds the checkout.
const ROOT = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
const INSTALL_RECORD = join(ROOT, "node_modules", ".starkeep-install.json");
const CLI_ENTRY = join(ROOT, "packages", "cli", "src", "bin.ts");

/** Commands that always run the install first, because they set the machine up. */
const INSTALLING_COMMANDS = new Set(["setup"]);

/**
 * Stop before the CLI runs. Under `--json`, the output still ends with one
 * result object, as the CLI's own failures do, so a script that reads it,
 * such as the process that continues `update --platform`, sees why.
 */
function fail(message) {
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ type: "result", ok: false, error: { message } })}\n`);
  } else {
    process.stderr.write(`\n${message}\n\n`);
  }
  process.exit(1);
}

function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 24) {
    fail(
      `Starkeep needs Node 24 or later, and this is Node ${process.versions.node}.\n` +
        "Install Node 24 (for example with `nvm install 24`), then run the command again.",
    );
  }
}

function pnpmOnPath() {
  const names = process.platform === "win32" ? ["pnpm.cmd", "pnpm.exe", "pnpm"] : ["pnpm"];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      try {
        accessSync(join(dir, name), constants.X_OK);
        return true;
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return false;
}

function checkPnpm() {
  if (!pnpmOnPath()) {
    fail(
      "Starkeep needs a `pnpm` command on your PATH. Install one with\n" +
        "`npm install -g pnpm@10`, then run the command again.",
    );
  }
}

/** The checkout's commit, or null outside git. */
function checkoutCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function lockfileHash() {
  try {
    return createHash("sha256")
      .update(readFileSync(join(ROOT, "pnpm-lock.yaml")))
      .digest("hex");
  } catch {
    return null;
  }
}

function readInstallRecord() {
  try {
    return JSON.parse(readFileSync(INSTALL_RECORD, "utf8"));
  } catch {
    return null;
  }
}

/** Whether the workspace has the CLI's runtime: tsx and the built packages. */
function installed() {
  return (
    existsSync(join(ROOT, "node_modules", "tsx", "package.json")) &&
    existsSync(join(ROOT, "packages", "app-client", "dist"))
  );
}

function install() {
  process.stderr.write("Installing Starkeep's dependencies (pnpm install)…\n");
  const result = spawnSync("pnpm", ["install"], { cwd: ROOT, stdio: ["ignore", 2, 2] });
  if (result.status !== 0) {
    fail(
      `pnpm install failed in ${ROOT} (exit code ${result.status ?? "none"}).\n` +
        "Fix the error above, then run the command again.",
    );
  }
}

/**
 * Record the commit and lockfile the install built. The root `postinstall`
 * runs this after the build, so every `pnpm install`, by hand or by this
 * wrapper, refreshes what the stale-build warning compares with.
 */
function recordInstall() {
  writeFileSync(
    INSTALL_RECORD,
    JSON.stringify({ commit: checkoutCommit(), lockfile: lockfileHash() }, null, 2) + "\n",
  );
}

function warnWhenStale() {
  const record = readInstallRecord();
  if (!record) return;
  const commit = checkoutCommit();
  const lockfile = lockfileHash();
  if (record.commit !== commit || record.lockfile !== lockfile) {
    process.stderr.write(
      "Warning: the checkout changed since the last install, so the built packages may be stale.\n" +
        `Run \`pnpm install\` in ${ROOT} to install and rebuild.\n`,
    );
  }
}

/** The tsx loader from the checkout's own install. */
function tsxLoader() {
  const require = createRequire(join(ROOT, "package.json"));
  return pathToFileURL(join(dirname(require.resolve("tsx/package.json")), "dist", "loader.mjs"))
    .href;
}

function main() {
  // The root `postinstall` passes `--record-install` once the build is done.
  if (process.argv.includes("--record-install")) {
    recordInstall();
    return;
  }
  // `--no-install` is the wrapper's own flag: skip the install `setup` runs,
  // for a checkout the caller knows is installed, such as in tests.
  const skipInstall = process.argv.includes("--no-install");
  // `--install-first` is the wrapper's own flag too: always install first.
  // `starkeep update --platform` passes it when it reruns itself after
  // pulling the checkout, so the rest of the update runs on the new code.
  const installFirst = process.argv.includes("--install-first");
  const args = process.argv.slice(2).filter((a) => a !== "--no-install" && a !== "--install-first");
  // `--help` and `help` work before anything is installed.
  const command = args.find((a) => !a.startsWith("-"));
  checkNode();
  checkPnpm();

  const wantsJson = args.includes("--json");
  // The install's output goes to stderr, so `--json` output stays clean.
  if (
    installFirst ||
    (command && INSTALLING_COMMANDS.has(command) && !skipInstall) ||
    !installed()
  ) {
    install();
  } else if (!wantsJson) {
    warnWhenStale();
  }

  const cwd = process.env.INIT_CWD ?? process.cwd();
  const result = spawnSync(process.execPath, ["--import", tsxLoader(), CLI_ENTRY, ...args], {
    cwd,
    stdio: "inherit",
    env: { ...process.env, STARKEEP_CWD: cwd, STARKEEP_CHECKOUT: ROOT },
  });
  if (result.error) fail(`Could not start the Starkeep CLI: ${result.error.message}`);
  process.exit(result.status ?? 1);
}

main();
