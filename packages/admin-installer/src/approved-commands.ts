/**
 * The commands admin-web and the cloud installer run in an app's folder: the
 * dependency install at Install, and the cloud bundle build.
 *
 * A manifest names each command in `installDependencies` and `bundle`, or
 * leaves it to be inferred from the app's lockfile. Either way the command
 * must match an approved shape before anything runs it:
 *
 * - The program is one of four package managers, matched by bare name and
 *   found on PATH. A path such as `./scripts/x` never matches.
 * - Install is `<manager> install` (or `npm ci`) with flags from a short list.
 * - Bundle is `<manager> run <script>`, with a plain script name.
 * - Nothing builds a shell string; the command spawns with an argument list.
 *
 * The list stops a manifest from naming an arbitrary program. It cannot stop
 * an approved command from running the app's own code: a package manager runs
 * the app's lifecycle scripts, and `run bundle` runs a script the app defines.
 * The user trusts that code at Start anyway, since `localRun` runs it; the
 * consent dialog says so.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** A manifest's `installDependencies` or `bundle`, as the file holds it. */
export interface DeclaredCommand {
  command: string;
  args?: string[];
  cwd?: string;
}

export interface CommandSource {
  installDependencies?: DeclaredCommand;
  bundle?: DeclaredCommand;
}

export type CommandResolution =
  /** Run `command args` in `cwd`; `display` is the same as one line of text. */
  | { kind: "run"; command: string; args: string[]; cwd: string; display: string }
  /** Nothing to run: the folder holds no package.json. */
  | { kind: "skip"; reason: string }
  /** The command is not on the approved list; `display` is what the user can run by hand. */
  | { kind: "refused"; display: string; cwd: string; reason: string };

type Manager = "pnpm" | "npm" | "yarn" | "bun";

/** Each manager's install subcommands and the flags an install may carry. */
const INSTALL_SHAPES: Record<Manager, { subcommands: string[]; flags: string[] }> = {
  pnpm: { subcommands: ["install"], flags: ["--frozen-lockfile", "--ignore-workspace", "--prod"] },
  npm: { subcommands: ["ci", "install"], flags: ["--omit=dev"] },
  yarn: { subcommands: ["install"], flags: ["--immutable", "--frozen-lockfile"] },
  bun: { subcommands: ["install"], flags: ["--frozen-lockfile", "--production"] },
};

const SCRIPT_NAME = /^[A-Za-z0-9:_-]+$/;

// packages/admin-installer/src -> admin-installer -> packages -> starkeep-core
const CORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Whether `dir` is an app core's own workspace lists, such as Probe. Core's
 * own install, at setup, already installed it, and an install at core's root
 * would run core's postinstall build under the admin-web it runs from.
 */
function inCoreWorkspace(dir: string): boolean {
  const ws = enclosingWorkspace(dir);
  if (!ws?.covers) return false;
  try {
    return realpathSync(ws.root) === realpathSync(CORE_ROOT);
  } catch {
    return false;
  }
}

/** Lockfile to the manager that writes it, and that manager's frozen install. */
const LOCKFILES: Array<{ file: string; manager: Manager; frozen: string[] }> = [
  { file: "pnpm-lock.yaml", manager: "pnpm", frozen: ["install", "--frozen-lockfile"] },
  { file: "package-lock.json", manager: "npm", frozen: ["ci"] },
  { file: "npm-shrinkwrap.json", manager: "npm", frozen: ["ci"] },
  { file: "yarn.lock", manager: "yarn", frozen: ["install", "--immutable"] },
  { file: "bun.lock", manager: "bun", frozen: ["install", "--frozen-lockfile"] },
  // Bun's binary lockfile, from before Bun 1.2.
  { file: "bun.lockb", manager: "bun", frozen: ["install", "--frozen-lockfile"] },
];

/** The frozen install for `lock` in `dir`. Yarn 1 spells it `--frozen-lockfile`. */
function frozenInstall(dir: string, lock: (typeof LOCKFILES)[number]): string[] {
  if (lock.manager !== "yarn") return lock.frozen;
  const v1 = readFileSync(join(dir, lock.file), "utf-8").includes("# yarn lockfile v1");
  return v1 ? ["install", "--frozen-lockfile"] : lock.frozen;
}

/**
 * The nearest folder above `dir` that holds a lockfile of a manager other
 * than pnpm: the root of an npm, Yarn or Bun workspace that `dir` sits in.
 */
function enclosingOtherLockfile(
  dir: string,
): { root: string; lock: (typeof LOCKFILES)[number] } | null {
  for (let d = dirname(resolve(dir)); ; d = dirname(d)) {
    const lock = LOCKFILES.find((l) => l.manager !== "pnpm" && existsSync(join(d, l.file)));
    if (lock) return { root: d, lock };
    if (dirname(d) === d) return null;
  }
}

function isManager(program: string): program is Manager {
  return Object.hasOwn(INSTALL_SHAPES, program);
}

function display(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

/**
 * The nearest pnpm workspace at or above `dir`, and whether it covers `dir`.
 * A workspace covers its own root and every folder its `packages` globs
 * match. pnpm run anywhere inside a workspace installs that workspace, so an
 * app inside one that does not cover it needs `--ignore-workspace` (#141).
 */
export function enclosingWorkspace(dir: string): { root: string; covers: boolean } | null {
  return workspaceFrom(resolve(dir), dir);
}

/** The nearest pnpm workspace at or above `start`, and whether it covers `dir`. */
function workspaceFrom(start: string, dir: string): { root: string; covers: boolean } | null {
  for (let d = start; ; d = dirname(d)) {
    const file = join(d, "pnpm-workspace.yaml");
    if (existsSync(file)) {
      const rel = relative(d, resolve(dir)).split(sep).join("/");
      return {
        root: d,
        covers: rel === "" || workspaceGlobsMatch(readFileSync(file, "utf-8"), rel),
      };
    }
    if (dirname(d) === d) return null;
  }
}

/**
 * A stray `pnpm-workspace.yaml` that hides the app from the workspace that
 * lists it.
 *
 * pnpm uses the nearest workspace file. A file that lists no packages, below
 * an outer workspace that lists the app, makes the app a workspace of its own,
 * and the outer workspace's packages vanish from pnpm's view. An app that
 * depends on a sibling with `workspace:*` then fails with
 * ERR_PNPM_WORKSPACE_PKG_NOT_FOUND. Admin cannot just install at the outer
 * root, because pnpm in the app's folder would still read the nested file.
 *
 * pnpm 10 keeps build approvals in `pnpm-workspace.yaml`, so approving builds
 * inside the app's folder can leave such a file behind, with no `packages`
 * list. A checkout from before 2026-08-25 ignored the file in git, so
 * `git pull` never removes it.
 *
 * An inner file that lists packages is a deliberate workspace, such as a copy
 * of core's example app, which carries its own. pnpm installs it correctly,
 * and deleting it would break the app, so it is not refused.
 */
export function nestedWorkspace(appDir: string): { file: string; outerRoot: string } | null {
  const inner = enclosingWorkspace(appDir);
  if (!inner) return null;
  const file = join(inner.root, "pnpm-workspace.yaml");
  if (workspaceGlobs(readFileSync(file, "utf-8")).length > 0) return null;
  const parent = dirname(inner.root);
  if (parent === inner.root) return null;
  const outer = workspaceFrom(parent, appDir);
  if (!outer?.covers) return null;
  return { file, outerRoot: outer.root };
}

/**
 * The arguments to spawn an approved command with, when no one sits at a
 * terminal to answer pnpm.
 *
 * pnpm asks before it deletes a `node_modules` that an install under other
 * settings built, and with no terminal it aborts with
 * ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY. The folder holds only
 * dependencies the same install puts back, so Admin lets pnpm delete it. The
 * flag stays out of `display`, which shows what a person would type.
 */
export function unattendedArgs(command: string, args: string[]): string[] {
  return command === "pnpm" && args[0] === "install"
    ? [...args, "--config.confirm-modules-purge=false"]
    : args;
}

/**
 * The `packages` globs of a pnpm-workspace.yaml, from a block list or a flow
 * list such as `packages: [web, "common"]`.
 */
function workspaceGlobs(yaml: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const line of yaml.split("\n")) {
    const key = line.match(/^packages\s*:\s*(.*)$/);
    if (key) {
      const flow = key[1]!
        .replace(/#.*$/, "")
        .trim()
        .match(/^\[(.*)\]$/);
      if (flow) {
        for (const item of flow[1]!.split(",")) {
          const glob = item.trim().replace(/^["']|["']$/g, "");
          if (glob) globs.push(glob);
        }
      } else {
        inPackages = true;
      }
      continue;
    }
    if (inPackages) {
      const item = line.match(/^\s+-\s*["']?([^"'#]+?)["']?\s*(#.*)?$/);
      if (item) globs.push(item[1]!.trim());
      else if (/^\S/.test(line)) inPackages = false;
    }
  }
  return globs;
}

/** Whether a pnpm-workspace.yaml's `packages` globs match a relative path. */
function workspaceGlobsMatch(yaml: string, rel: string): boolean {
  const globs = workspaceGlobs(yaml);
  const toRegex = (glob: string) =>
    new RegExp(
      "^" +
        glob
          .replace(/\/$/, "")
          .split("**")
          .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
          .join(".*") +
        "$",
    );
  let matched = false;
  for (const glob of globs) {
    if (glob.startsWith("!")) {
      if (toRegex(glob.slice(1)).test(rel)) return false;
    } else if (toRegex(glob).test(rel)) {
      matched = true;
    }
  }
  return matched;
}

/** `cwd` from a manifest, which must stay inside the app's folder. */
function declaredCwd(appDir: string, cwd: string | undefined): string | null {
  const dir = resolve(appDir, cwd ?? ".");
  const rel = relative(appDir, dir);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? dir : null;
}

/**
 * The approved dependency install for the app in `appDir`, or why there is
 * none. A pnpm install inside a workspace that does not cover the app gains
 * `--ignore-workspace`. An app core's own workspace lists installs nothing,
 * declared or not. An app hidden from its workspace by a nested
 * `pnpm-workspace.yaml` runs nothing, and the refusal names the file (see
 * {@link nestedWorkspace}). Without a declared command:
 *
 * - a folder with no package.json installs nothing;
 * - a lockfile beside package.json picks its manager's frozen install;
 * - an app a pnpm workspace covers installs at the workspace root;
 * - an app inside an npm, Yarn or Bun project runs nothing, and the refusal
 *   names that project's install, because a manifest cannot point outside
 *   the app's folder;
 * - anything else runs `pnpm install`.
 */
export function resolveInstallCommand(appDir: string, manifest: CommandSource): CommandResolution {
  if (inCoreWorkspace(appDir)) {
    return { kind: "skip", reason: "Core's own install installs the apps in core's workspace." };
  }
  const nested = nestedWorkspace(appDir);
  if (nested) {
    const frozen = existsSync(join(nested.outerRoot, "pnpm-lock.yaml"))
      ? ["--frozen-lockfile"]
      : [];
    return {
      kind: "refused",
      display: display("pnpm", ["install", ...frozen]),
      cwd: nested.outerRoot,
      reason:
        `${nested.file} lists no packages, and makes pnpm treat the app's folder as a workspace of its own, ` +
        `apart from the workspace at ${nested.outerRoot} that lists the app. Delete ${nested.file}.`,
    };
  }
  const declared = manifest.installDependencies;
  if (declared) {
    const args = declared.args ?? [];
    const cwd = declaredCwd(appDir, declared.cwd);
    const shown = display(declared.command, args);
    const refuse = (reason: string): CommandResolution => ({
      kind: "refused",
      display: shown,
      cwd: cwd ?? resolve(appDir, declared.cwd ?? "."),
      reason,
    });
    if (!cwd) return refuse("Its folder is outside the app's folder.");
    if (!isManager(declared.command)) {
      return refuse(`${declared.command} is not an approved package manager.`);
    }
    const shape = INSTALL_SHAPES[declared.command];
    const [subcommand, ...flags] = args;
    if (!subcommand || !shape.subcommands.includes(subcommand)) {
      return refuse(`${display(declared.command, args.slice(0, 1))} is not an approved install.`);
    }
    const unknown = flags.find((f) => !shape.flags.includes(f));
    if (unknown !== undefined) return refuse(`${unknown} is not an approved flag.`);
    return run(declared.command, args, cwd);
  }

  if (!existsSync(join(appDir, "package.json"))) {
    return { kind: "skip", reason: "The app's folder has no package.json." };
  }
  const own = LOCKFILES.find((l) => existsSync(join(appDir, l.file)));
  if (own) return run(own.manager, frozenInstall(appDir, own), appDir);
  const ws = enclosingWorkspace(appDir);
  if (ws?.covers) {
    const frozen = existsSync(join(ws.root, "pnpm-lock.yaml")) ? ["--frozen-lockfile"] : [];
    return run("pnpm", ["install", ...frozen], ws.root);
  }
  const other = enclosingOtherLockfile(appDir);
  if (other) {
    return {
      kind: "refused",
      display: display(other.lock.manager, frozenInstall(other.root, other.lock)),
      cwd: other.root,
      reason: `The app sits inside the ${other.lock.manager} project at ${other.root}, outside the app's folder.`,
    };
  }
  return run("pnpm", ["install"], appDir);
}

/** Add `--ignore-workspace` where pnpm would otherwise install an enclosing workspace. */
function run(command: Manager, args: string[], cwd: string): CommandResolution {
  const ws = command === "pnpm" ? enclosingWorkspace(cwd) : null;
  const full =
    ws && !ws.covers && !args.includes("--ignore-workspace")
      ? [...args, "--ignore-workspace"]
      : args;
  return { kind: "run", command, args: full, cwd, display: display(command, full) };
}

/**
 * The approved cloud bundle build for the app in `appDir`: the manifest's
 * `bundle`, or `<manager> run bundle` with the manager its lockfile names
 * (pnpm when it names none).
 */
export function resolveBundleCommand(appDir: string, manifest: CommandSource): CommandResolution {
  const declared = manifest.bundle;
  if (declared) {
    const args = declared.args ?? [];
    const cwd = declaredCwd(appDir, declared.cwd);
    const refuse = (reason: string): CommandResolution => ({
      kind: "refused",
      display: display(declared.command, args),
      cwd: cwd ?? resolve(appDir, declared.cwd ?? "."),
      reason,
    });
    if (!cwd) return refuse("Its folder is outside the app's folder.");
    if (!isManager(declared.command)) {
      return refuse(`${declared.command} is not an approved package manager.`);
    }
    if (args.length !== 2 || args[0] !== "run" || !SCRIPT_NAME.test(args[1]!)) {
      return refuse(`A bundle command must be \`${declared.command} run <script>\`.`);
    }
    return {
      kind: "run",
      command: declared.command,
      args,
      cwd,
      display: display(declared.command, args),
    };
  }
  const own = LOCKFILES.find((l) => existsSync(join(appDir, l.file)));
  const manager = own?.manager ?? "pnpm";
  const args = ["run", "bundle"];
  return { kind: "run", command: manager, args, cwd: appDir, display: display(manager, args) };
}
