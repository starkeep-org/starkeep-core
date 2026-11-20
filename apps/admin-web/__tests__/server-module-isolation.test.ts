/**
 * Nothing the browser loads may reach the modules that spawn processes and read
 * the filesystem.
 *
 * `@starkeep/operator` holds the code that touches `node:child_process` and
 * `node:fs`: daemon control, detached runs, app discovery and the config file.
 * Every import of the package counts as reaching it. The line used to be held by a
 * `server-only` import — a marker package the previous bundler resolved and
 * refused in a client graph. There is no such package in this tree, and the
 * bundler that ships the browser half now would not know the convention if
 * there were: an SPA entry that imported the daemon-control code would simply bundle
 * `node:child_process` for the browser, with no error anywhere.
 *
 * So the marker is replaced by two things that depend on no bundler
 * convention: an eslint `no-restricted-imports` rule for the edit that
 * introduces it, and this test, which walks the real import graph in CI.
 *
 * `src/main.tsx` is the whole of the browser half's entry now — one file, and
 * everything the bundle contains is reachable from it. The per-file cases below
 * it are not redundant: a failure there names the page or component that
 * introduced the edge, which the single entry-point case cannot.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

/**
 * The package that must never be reachable from anything the browser runs. Its
 * specifiers stand in the graph as pseudo-files under this prefix.
 */
const SERVER_ONLY_PACKAGE = "@starkeep/operator";
const SERVER_ONLY_PREFIX = `package:${SERVER_ONLY_PACKAGE}`;
const isServerOnly = (node: string) => node.startsWith(SERVER_ONLY_PREFIX);

const rel = (file: string) =>
  file.startsWith("package:") ? file.slice(8) : relative(APP_DIR, file);

/** Every file in this package reachable from `entry`. */
function reachableFrom(entry: string): string[] {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const specifier of specifiersIn(file)) {
      const resolved = resolveLocal(file, specifier);
      if (!resolved || seen.has(resolved)) continue;
      seen.add(resolved);
      queue.push(resolved);
    }
  }
  return [...seen];
}

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
  if (file.startsWith("package:")) return [];
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
  else if (specifier === SERVER_ONLY_PACKAGE || specifier.startsWith(`${SERVER_ONLY_PACKAGE}/`)) {
    return `package:${specifier}`;
  } else return null; // another package — not part of this graph

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
function chainTo(entry: string): string[] | null {
  const queue: string[][] = [[entry]];
  const seen = new Set<string>([entry]);
  while (queue.length > 0) {
    const chain = queue.shift()!;
    const file = chain[chain.length - 1]!;
    if (chain.length > 1 && isServerOnly(file)) return chain;
    for (const specifier of specifiersIn(file)) {
      const resolved = resolveLocal(file, specifier);
      if (!resolved || seen.has(resolved)) continue;
      seen.add(resolved);
      queue.push([...chain, resolved]);
    }
  }
  return null;
}

/** The browser bundle's one entry point. */
const BROWSER_ENTRY = join(APP_DIR, "src", "main.tsx");

/**
 * The pages and components the router renders, checked individually so a
 * failure names the file that introduced the edge rather than only the entry.
 */
const clientModules = [
  BROWSER_ENTRY,
  join(APP_DIR, "src", "App.tsx"),
  ...walk(join(APP_DIR, "src", "pages")),
  ...walk(join(APP_DIR, "src", "components")),
  ...walk(join(APP_DIR, "src", "hooks")),
];

describe("the traversal itself", () => {
  it("finds the entry, the pages and the components it is meant to be checking", () => {
    // A traversal bug that found nothing would make every assertion below pass
    // vacuously — the one shape of failure a guard must not have.
    const names = clientModules.map(rel);
    expect(names).toContain("src/main.tsx");
    expect(names).toContain("src/pages/Dashboard.tsx");
    expect(names).toContain("src/pages/CloudSetup.tsx");
    expect(names).toContain("src/pages/Storage.tsx");
    expect(names).toContain("src/components/CloudSetupWizard.tsx");
    expect(clientModules.length).toBeGreaterThan(20);
  });

  it("reaches the pages from the entry, so the entry case is not trivially clean", () => {
    // If `main.tsx` reached nothing it would reach no server module either.
    const reached = reachableFrom(BROWSER_ENTRY).map(rel);
    expect(reached).toContain("src/pages/Dashboard.tsx");
    expect(reached).toContain("src/components/CloudSetupWizard.tsx");
    expect(reached).toContain("src/lib/cognito-auth.ts");
  });

  it("finds a chain when there is one", () => {
    // The complement: a route module does reach these, on purpose, so the
    // assertions below are failing to find something that is findable.
    expect(chainTo(join(APP_DIR, "src", "routes", "exec-daemon.ts"))).not.toBeNull();
  });

  it("names a package admin-web depends on", () => {
    const pkg = JSON.parse(readFileSync(join(APP_DIR, "package.json"), "utf-8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies[SERVER_ONLY_PACKAGE]).toBeDefined();
  });
});

describe("the browser bundle reaches no server-only module", () => {
  it("src/main.tsx — the whole of what ships to the browser", () => {
    const chain = chainTo(BROWSER_ENTRY);
    expect(
      chain === null,
      chain
        ? `the browser bundle reaches a server-only module:\n  ${chain.map(rel).join("\n\u2192 ")}`
        : undefined,
    ).toBe(true);
  });

  it.each(clientModules.map((file) => [rel(file), file] as const))("%s", (_name, file) => {
    const chain = chainTo(file);
    expect(
      chain === null,
      chain
        ? `import chain into a server-only module:\n  ${chain.map(rel).join("\n\u2192 ")}`
        : undefined,
    ).toBe(true);
  });
});

describe("the marker it replaced", () => {
  it("is gone from the tree, rather than left in place enforcing nothing", () => {
    // `server-only` was never a declared dependency, and the bundler that
    // resolved it is gone. Left in the source it would read as a guard while
    // being an unresolvable import, so the graph walk above is the whole
    // statement now and the marker must not come back. The *words* still appear
    // in comments here, which is why this looks for
    // the import rather than the text.
    const marked = walk(join(APP_DIR, "src")).filter((file) =>
      /(?:^|\s)import\s*["']server-only["']/.test(readFileSync(file, "utf-8")),
    );
    expect(marked.map(rel)).toEqual([]);
  });
});
