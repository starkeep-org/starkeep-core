/**
 * Start names an app's missing dependencies before it spawns anything (#141).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { makeDataDir } from "./helpers";

// daemon-control resolves the Starkeep directory when it loads.
let missingDependencies: (typeof import("../src/lib/daemon-control"))["missingDependencies"];
beforeAll(async () => {
  process.env.STARKEEP_DIR = makeDataDir("adminweb-deps-");
  ({ missingDependencies } = await import("../src/lib/daemon-control"));
});

function dir(...parts: string[]): string {
  const path = join(...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value));
}

/** An installed package: what Node finds at node_modules/<name>/package.json. */
function installPackage(root: string, name: string) {
  writeJson(join(dir(root, "node_modules", name), "package.json"), { name });
}

describe("missingDependencies", () => {
  it("passes an app whose dependencies all resolve, from its folder or an ancestor", () => {
    const root = mkdtempSync(join(tmpdir(), "deps-"));
    const app = dir(root, "app");
    writeJson(join(app, "package.json"), {
      dependencies: { hono: "^4.0.0", "@starkeep/app-client": "^0.10.0" },
    });
    installPackage(app, "hono");
    installPackage(root, "@starkeep/app-client");
    expect(missingDependencies("app", app)).toBeNull();
  });

  it("names the packages that an enclosing workspace's install left out", () => {
    // The #141 case: an app copied into another repository's workspace without
    // being listed there. The workspace has node_modules; the app's packages
    // are not in it.
    const ws = mkdtempSync(join(tmpdir(), "deps-ws-"));
    writeFileSync(join(ws, "pnpm-workspace.yaml"), "packages:\n  - photos\n");
    installPackage(ws, "typescript");
    const app = dir(ws, "dice");
    writeJson(join(app, "package.json"), { dependencies: { hono: "^4.0.0" } });

    const result = missingDependencies("dice", app);
    expect(result?.missing).toEqual(["hono"]);
    expect(result?.message).toContain("1 dependency is not installed (hono)");
    expect(result?.message).toContain(`not listed in that workspace's pnpm-workspace.yaml`);
  });

  it("checks from the nearest package.json above a localRun cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "deps-cwd-"));
    writeJson(join(root, "package.json"), { dependencies: { hono: "^4.0.0" } });
    const result = missingDependencies("app", dir(root, "web", "src"));
    expect(result?.message).toContain(`Run \`pnpm install\` in ${root}.`);
  });

  it("ignores a folder with no package.json", () => {
    expect(missingDependencies("app", mkdtempSync(join(tmpdir(), "deps-none-")))).toBeNull();
  });
});
