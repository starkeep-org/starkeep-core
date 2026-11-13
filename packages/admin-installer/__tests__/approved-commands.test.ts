/**
 * The commands Install and the cloud installer may run in an app's folder:
 * inferred from the lockfile, or declared in the manifest and checked against
 * the approved shapes.
 */

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  enclosingWorkspace,
  nestedWorkspace,
  resolveBundleCommand,
  resolveInstallCommand,
  unattendedArgs,
} from "../src/approved-commands.js";

/** A fresh folder holding `files` (name to content). */
function folder(files: Record<string, string> = {}, root?: string, name = "app"): string {
  const dir = root ? join(root, name) : mkdtempSync(join(tmpdir(), "approved-"));
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
  return dir;
}

const PKG = { "package.json": "{}" };

describe("resolveInstallCommand, inferred", () => {
  it.each([
    ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
    ["package-lock.json", "npm ci"],
    ["yarn.lock", "yarn install --immutable"],
    ["bun.lock", "bun install --frozen-lockfile"],
    ["bun.lockb", "bun install --frozen-lockfile"],
    ["npm-shrinkwrap.json", "npm ci"],
  ])("picks the frozen install for %s", (lockfile, expected) => {
    const app = folder({ ...PKG, [lockfile]: "" });
    expect(resolveInstallCommand(app, {})).toMatchObject({
      kind: "run",
      display: expected,
      cwd: app,
    });
  });

  it("installs nothing for a folder with no package.json", () => {
    expect(resolveInstallCommand(folder(), {})).toEqual({
      kind: "skip",
      reason: "The app's folder has no package.json.",
    });
  });

  it("installs at the root of a pnpm workspace that lists the app", () => {
    const ws = folder({ "pnpm-workspace.yaml": 'packages:\n  - "photos"\n', "pnpm-lock.yaml": "" });
    folder(PKG, ws, "photos");
    expect(resolveInstallCommand(join(ws, "photos"), {})).toMatchObject({
      kind: "run",
      command: "pnpm",
      args: ["install", "--frozen-lockfile"],
      cwd: ws,
    });
  });

  it("adds --ignore-workspace inside a pnpm workspace that does not list the app", () => {
    const ws = folder({ "pnpm-workspace.yaml": "packages:\n  - photos\n" });
    const app = folder({ ...PKG, "pnpm-lock.yaml": "" }, ws, "dice");
    expect(resolveInstallCommand(app, {})).toMatchObject({
      display: "pnpm install --frozen-lockfile --ignore-workspace",
      cwd: app,
    });
  });

  it("treats an app that is its own pnpm workspace as covered", () => {
    const outer = folder({ "pnpm-workspace.yaml": "packages:\n  - other\n" });
    const app = folder(
      { ...PKG, "pnpm-lock.yaml": "", "pnpm-workspace.yaml": "packages:\n  - web\n" },
      outer,
      "example-app",
    );
    expect(resolveInstallCommand(app, {})).toMatchObject({
      display: "pnpm install --frozen-lockfile",
      cwd: app,
    });
  });

  it("refuses an app that a nested pnpm-workspace.yaml hides from the workspace listing it", () => {
    // A July checkout of starkeep-apps: the root workspace lists photos, and
    // a git-ignored photos/pnpm-workspace.yaml survives every pull.
    const ws = folder({ "pnpm-workspace.yaml": 'packages:\n  - "photos"\n', "pnpm-lock.yaml": "" });
    const app = folder(
      { ...PKG, "pnpm-workspace.yaml": "onlyBuiltDependencies:\n  - sharp\n" },
      ws,
      "photos",
    );
    const file = join(app, "pnpm-workspace.yaml");
    expect(nestedWorkspace(app)).toEqual({ file, outerRoot: ws });
    for (const manifest of [{}, { installDependencies: { command: "pnpm", args: ["install"] } }]) {
      expect(resolveInstallCommand(app, manifest)).toEqual({
        kind: "refused",
        display: "pnpm install --frozen-lockfile",
        cwd: ws,
        reason:
          `${file} lists no packages, and makes pnpm treat the app's folder as a workspace of its own, ` +
          `apart from the workspace at ${ws} that lists the app. Delete ${file}.`,
      });
    }
  });

  it("refuses a stray file whose packages list is an empty flow list", () => {
    const ws = folder({ "pnpm-workspace.yaml": "packages:\n  - photos\n" });
    const app = folder({ ...PKG, "pnpm-workspace.yaml": "packages: []\n" }, ws, "photos");
    expect(nestedWorkspace(app)).toEqual({ file: join(app, "pnpm-workspace.yaml"), outerRoot: ws });
  });

  // A copy of core's example app keeps its own workspace file, which lists
  // its packages. The outer workspace does not list those, so deleting the
  // file, as a refusal would advise, breaks the app's `workspace:*` links.
  it.each([
    ["a block list", "packages:\n  - common\n  - web\n"],
    ["a flow list", 'packages: [common, "web"] # the app\'s packages\n'],
  ])("installs a deliberate workspace inside a workspace that lists it, from %s", (_, yaml) => {
    const ws = folder({ "pnpm-workspace.yaml": "packages:\n  - apps/*\n" });
    mkdirSync(join(ws, "apps"));
    const app = folder(
      { ...PKG, "pnpm-lock.yaml": "", "pnpm-workspace.yaml": yaml },
      join(ws, "apps"),
      "my-app",
    );
    expect(nestedWorkspace(app)).toBeNull();
    expect(resolveInstallCommand(app, {})).toMatchObject({
      kind: "run",
      display: "pnpm install --frozen-lockfile",
      cwd: app,
    });
  });

  // pnpm uses the nearest workspace, which lists the app, so an outer `**`
  // glob that also matches it hides nothing.
  it("installs at a middle workspace that lists the app below an outer ** glob", () => {
    const outer = folder({ "pnpm-workspace.yaml": 'packages:\n  - "**"\n' });
    const middle = folder(
      { "pnpm-workspace.yaml": "packages:\n  - apps/*\n", "pnpm-lock.yaml": "" },
      outer,
      "mono",
    );
    mkdirSync(join(middle, "apps"));
    const app = folder(PKG, join(middle, "apps"), "photos");
    expect(nestedWorkspace(app)).toBeNull();
    expect(resolveInstallCommand(app, {})).toMatchObject({
      kind: "run",
      display: "pnpm install --frozen-lockfile",
      cwd: middle,
    });
  });

  it("installs nothing for an app core's own workspace lists, even a declared command", () => {
    const probe = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test-apps/probe");
    for (const manifest of [{}, { installDependencies: { command: "pnpm", args: ["install"] } }]) {
      expect(resolveInstallCommand(probe, manifest)).toEqual({
        kind: "skip",
        reason: "Core's own install installs the apps in core's workspace.",
      });
    }
  });

  it("picks Yarn 1's frozen install for a v1 yarn.lock", () => {
    const app = folder({
      ...PKG,
      "yarn.lock": "# THIS IS AN AUTOGENERATED FILE.\n# yarn lockfile v1\n",
    });
    expect(resolveInstallCommand(app, {})).toMatchObject({
      kind: "run",
      display: "yarn install --frozen-lockfile",
    });
  });

  it("refuses an app inside an npm project, and names that project's install", () => {
    const project = folder({ ...PKG, "package-lock.json": "{}" });
    const app = folder(PKG, project, "dice");
    expect(resolveInstallCommand(app, {})).toEqual({
      kind: "refused",
      display: "npm ci",
      cwd: project,
      reason: `The app sits inside the npm project at ${project}, outside the app's folder.`,
    });
  });

  it("runs a plain pnpm install for a package.json with no lockfile or workspace", () => {
    const app = folder(PKG);
    expect(resolveInstallCommand(app, {})).toMatchObject({ display: "pnpm install", cwd: app });
  });
});

describe("resolveInstallCommand, declared", () => {
  it.each([
    ["pnpm", ["install", "--frozen-lockfile", "--prod"]],
    ["npm", ["ci"]],
    ["npm", ["install", "--omit=dev"]],
    ["yarn", ["install", "--immutable"]],
    ["yarn", ["install", "--frozen-lockfile"]],
    ["bun", ["install", "--production"]],
  ])("runs the approved shape %s %j", (command, args) => {
    const app = folder(PKG);
    expect(resolveInstallCommand(app, { installDependencies: { command, args } })).toEqual({
      kind: "run",
      command,
      args,
      cwd: app,
      display: [command, ...args].join(" "),
    });
  });

  it("runs in a cwd inside the app's folder, and adds --ignore-workspace there too", () => {
    const ws = folder({ "pnpm-workspace.yaml": "packages:\n  - other\n" });
    const app = folder(PKG, ws, "dice");
    mkdirSync(join(app, "web"));
    expect(
      resolveInstallCommand(app, {
        installDependencies: { command: "pnpm", args: ["install"], cwd: "web" },
      }),
    ).toMatchObject({
      kind: "run",
      args: ["install", "--ignore-workspace"],
      cwd: join(app, "web"),
    });
  });

  it.each([
    [{ command: "./scripts/install.sh", args: [] }, "is not an approved package manager"],
    [{ command: "/usr/bin/pnpm", args: ["install"] }, "is not an approved package manager"],
    [{ command: "make", args: ["install"] }, "is not an approved package manager"],
    [{ command: "pnpm", args: ["add", "left-pad"] }, "pnpm add is not an approved install"],
    [{ command: "pnpm", args: [] }, "pnpm is not an approved install"],
    [
      { command: "npm", args: ["install", "--unsafe-perm"] },
      "--unsafe-perm is not an approved flag",
    ],
    [{ command: "pnpm", args: ["install", "&&", "rm"] }, "&& is not an approved flag"],
    [{ command: "pnpm", args: ["install"], cwd: "../.." }, "outside the app's folder"],
  ])("refuses %j", (declared, reason) => {
    const app = folder(PKG);
    const result = resolveInstallCommand(app, { installDependencies: declared });
    expect(result.kind).toBe("refused");
    expect(result).toMatchObject({
      display: [declared.command, ...declared.args].join(" "),
      reason: expect.stringContaining(reason),
    });
  });
});

describe("resolveBundleCommand", () => {
  it("infers `<manager> run bundle` from the lockfile, pnpm by default", () => {
    expect(resolveBundleCommand(folder({ "package-lock.json": "" }), {})).toMatchObject({
      display: "npm run bundle",
    });
    expect(resolveBundleCommand(folder(PKG), {})).toMatchObject({ display: "pnpm run bundle" });
  });

  it("runs a declared `<manager> run <script>`", () => {
    const app = folder(PKG);
    expect(
      resolveBundleCommand(app, { bundle: { command: "yarn", args: ["run", "build:cloud"] } }),
    ).toEqual({
      kind: "run",
      command: "yarn",
      args: ["run", "build:cloud"],
      cwd: app,
      display: "yarn run build:cloud",
    });
  });

  it.each([
    [{ command: "pnpm", args: ["run", "bundle; rm -rf /"] }, "must be `pnpm run <script>`"],
    [{ command: "pnpm", args: ["run", "$(id)"] }, "must be `pnpm run <script>`"],
    [{ command: "pnpm", args: ["exec", "esbuild"] }, "must be `pnpm run <script>`"],
    [{ command: "pnpm", args: ["run", "bundle", "--", "x"] }, "must be `pnpm run <script>`"],
    [{ command: "node", args: ["bundle.mjs"] }, "is not an approved package manager"],
  ])("refuses %j", (declared, reason) => {
    const result = resolveBundleCommand(folder(PKG), { bundle: declared });
    expect(result).toMatchObject({ kind: "refused", reason: expect.stringContaining(reason) });
  });
});

describe("enclosingWorkspace", () => {
  it("matches globs, ** and negations", () => {
    const ws = folder({
      "pnpm-workspace.yaml":
        "packages:\n  - 'packages/*'\n  - apps/**\n  - '!packages/private'\n# trailing\n",
    });
    expect(enclosingWorkspace(folder({}, ws, "packages/ui"))?.covers).toBe(true);
    expect(enclosingWorkspace(folder({}, ws, "apps/a/b"))?.covers).toBe(true);
    expect(enclosingWorkspace(folder({}, ws, "packages/private"))?.covers).toBe(false);
    expect(enclosingWorkspace(folder({}, ws, "other"))?.covers).toBe(false);
    expect(enclosingWorkspace(folder({}, ws, "packages/ui/deep"))?.covers).toBe(false);
    expect(enclosingWorkspace(folder())).toBeNull();
  });
});

describe("unattendedArgs", () => {
  it("lets a pnpm install delete a stale node_modules without a terminal", () => {
    expect(unattendedArgs("pnpm", ["install", "--frozen-lockfile"])).toEqual([
      "install",
      "--frozen-lockfile",
      "--config.confirm-modules-purge=false",
    ]);
  });

  it("leaves every other command as it is", () => {
    expect(unattendedArgs("npm", ["ci"])).toEqual(["ci"]);
    expect(unattendedArgs("pnpm", ["run", "bundle"])).toEqual(["run", "bundle"]);
  });
});
