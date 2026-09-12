/**
 * Nothing the browser loads may reach the modules that spawn processes and read
 * the filesystem.
 *
 * `src/lib/app-scan.ts`, `src/lib/daemon-control.ts` and
 * `src/lib/exec-commands.ts` are the three modules that touch
 * `node:child_process` and `node:fs`. Today the line is held by a `server-only`
 * import, which is a marker package the framework's bundler resolves — there is
 * no such package in this tree, which is why `vitest.config.ts` has to alias it
 * to a stub. A bundler that does not know the convention enforces nothing, and
 * a client entry that imported `exec-commands.ts` would put
 * `node:child_process` in the browser graph with no error anywhere.
 *
 * So the marker is replaced by two things that do not depend on a bundler
 * convention: an eslint `no-restricted-imports` rule for the edit that
 * introduces it, and this test, which walks the real import graph in CI.
 *
 * Written while `server-only` still holds the line, so it is verified against a
 * graph known to be clean.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

/** The modules that must never be reachable from anything the browser runs. */
const SERVER_ONLY = [
  join(APP_DIR, "src", "lib", "app-scan.ts"),
  join(APP_DIR, "src", "lib", "daemon-control.ts"),
  join(APP_DIR, "src", "lib", "exec-commands.ts"),
];

const rel = (file: string) => relative(APP_DIR, file);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (SOURCE_EXTENSIONS.some((ext) => full.endsWith(ext))) out.push(full);
  }
  return out;
}

/** Every `from "..."` / `import("...")` specifier in a source file. */
function specifiersIn(file: string): string[] {
  const source = readFileSync(file, "utf-8");
  const out: string[] = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) out.push(match[1]!);
  }
  return out;
}

/** Resolve a specifier to a file in this package, or null if it leaves it. */
function resolveLocal(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(APP_DIR, "src", specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(fromFile), specifier);
  else return null; // a package — not part of this graph

  for (const candidate of [
    base,
    ...SOURCE_EXTENSIONS.map((ext) => base + ext),
    ...SOURCE_EXTENSIONS.map((ext) => join(base, `index${ext}`)),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * Breadth-first over the import graph. Returns the first chain that reaches one
 * of the targets, so a failure names the path rather than only the fact.
 */
function chainTo(entry: string, targets: string[]): string[] | null {
  const queue: string[][] = [[entry]];
  const seen = new Set<string>([entry]);
  while (queue.length > 0) {
    const chain = queue.shift()!;
    const file = chain[chain.length - 1]!;
    if (chain.length > 1 && targets.includes(file)) return chain;
    for (const specifier of specifiersIn(file)) {
      const resolved = resolveLocal(file, specifier);
      if (!resolved || seen.has(resolved)) continue;
      seen.add(resolved);
      queue.push([...chain, resolved]);
    }
  }
  return null;
}

/**
 * What the browser loads: the pages and layouts the router renders, plus every
 * component. The page files are the client entry today and the router's route
 * components after the migration, so the set of files this walks does not
 * change when the framework does.
 */
const clientEntries = [
  ...walk(join(APP_DIR, "app")).filter((f) => !f.includes(`${join("app", "api")}`)),
  ...walk(join(APP_DIR, "src", "components")),
  ...walk(join(APP_DIR, "src", "hooks")),
];

describe("the traversal itself", () => {
  it("finds the pages and components it is meant to be checking", () => {
    // A traversal bug that found nothing would make every assertion below pass
    // vacuously — the one shape of failure a guard must not have.
    const names = clientEntries.map(rel);
    expect(names).toContain("app/(shell)/page.tsx");
    expect(names).toContain("app/(shell)/cloud-setup/page.tsx");
    expect(names).toContain("app/(shell)/storage/page.tsx");
    expect(names).toContain("src/components/CloudSetupWizard.tsx");
    expect(clientEntries.length).toBeGreaterThan(20);
  });

  it("finds a chain when there is one", () => {
    // The complement: a route handler does reach these modules, on purpose, so
    // the assertions below are failing to find something that is findable.
    const chain = chainTo(join(APP_DIR, "app", "api", "exec", "daemon", "route.ts"), SERVER_ONLY);
    expect(chain).not.toBeNull();
  });

  it("names each server-only module as a file that exists", () => {
    for (const file of SERVER_ONLY) {
      expect(statSync(file).isFile(), `${rel(file)} is no longer where this test looks`).toBe(true);
    }
  });
});

describe("no client entry reaches a server-only module", () => {
  it.each(clientEntries.map((file) => [rel(file), file] as const))("%s", (_name, file) => {
    const chain = chainTo(file, SERVER_ONLY);
    expect(
      chain === null,
      chain ? `import chain into a server-only module:\n  ${chain.map(rel).join("\n→ ")}` : undefined,
    ).toBe(true);
  });
});

describe("the list and the marker say the same thing", () => {
  // Keeps the list honest from the other direction. While `server-only` is
  // still in the tree the two must agree exactly, so a module that acquires the
  // marker without joining this list — or the reverse — fails here rather than
  // going unguarded. When the marker goes, this pair of assertions goes with
  // it and the list above becomes the whole statement.

  it("every module on the list carries the marker", () => {
    for (const file of SERVER_ONLY) {
      expect(readFileSync(file, "utf-8"), rel(file)).toContain('import "server-only"');
    }
  });

  it("every module carrying the marker is on the list", () => {
    const marked = [...walk(join(APP_DIR, "src")), ...walk(join(APP_DIR, "app"))].filter((file) =>
      readFileSync(file, "utf-8").includes('import "server-only"'),
    );
    expect(marked.map(rel).sort()).toEqual(SERVER_ONLY.map(rel).sort());
  });
});
