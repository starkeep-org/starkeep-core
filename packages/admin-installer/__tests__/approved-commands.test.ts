/**
 * The commands Install and the cloud installer may run in an app's folder:
 * inferred from the lockfile, or declared in the manifest and checked against
 * the approved shapes.
 */

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enclosingWorkspace,
  resolveBundleCommand,
  resolveInstallCommand,
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
