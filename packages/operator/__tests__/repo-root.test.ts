/**
 * Every daemon and installer run spawns from the checkout's root, so the root
 * must resolve the same way from the package, from a nested folder and through
 * a symlinked path.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { findRepoRoot, isStarkeepRoot, repoRoot } from "../src/repo-root";

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scratch = mkdtempSync(join(tmpdir(), "operator-repo-root-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("repoRoot", () => {
  it("is the checkout that holds this package", () => {
    expect(repoRoot()).toBe(CHECKOUT);
    expect(isStarkeepRoot(CHECKOUT)).toBe(true);
  });

  it("walks past a nested workspace that does not list apps/*", () => {
    const outer = join(scratch, "outer");
    const inner = join(outer, "apps", "some-app");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(outer, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n  - "apps/*"\n');
    writeFileSync(join(inner, "pnpm-workspace.yaml"), "packages:\n  - web\n");
    expect(findRepoRoot(join(inner, "src"))).toBe(outer);
  });

  it("resolves the same root through a symlinked path", () => {
    const link = join(scratch, "linked-checkout");
    symlinkSync(CHECKOUT, link);
    expect(findRepoRoot(join(link, "packages", "operator", "src"))).toBe(link);
    // repoRoot() itself reads the real path, so a symlink never changes it.
    expect(repoRoot()).toBe(CHECKOUT);
  });

  it("finds nothing outside a checkout", () => {
    expect(findRepoRoot(scratch)).toBeNull();
  });
});
