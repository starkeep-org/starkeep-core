/**
 * Nothing the browser loads may reach the module that holds Drive's credential.
 *
 * `src/lib/drive-client.ts` opens the local-data-server's SQLite registry,
 * reads Drive's `hmac_secret` and signs requests with it. That it runs on the
 * server is Drive's entire reason for having a server: a browser cannot hold
 * that secret, and a bundler asked to include this module would not say so — it
 * would emit `node:sqlite` for the browser and fail at runtime, or worse, ship
 * the signing code to a page.
 *
 * `src/lib/file-link.ts` is the deliberate counter-example. It is free of
 * `node:*` imports so both halves can share the link contract, and the test
 * below checks that the browser really does reach it, so the assertions here
 * are not passing over an empty graph.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

/** The modules that must never be reachable from anything the browser runs. */
const SERVER_ONLY = [
  join(APP_DIR, "src", "lib", "drive-client.ts"),
  join(APP_DIR, "src", "api.ts"),
  join(APP_DIR, "src", "client-serving.ts"),
  join(APP_DIR, "src", "server.ts"),
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

/** The browser bundle's one entry point. */
const BROWSER_ENTRY = join(APP_DIR, "src", "main.tsx");

describe("the traversal itself", () => {
  it("names each server-only module as a file that exists", () => {
    for (const file of SERVER_ONLY) {
      expect(statSync(file).isFile(), `${rel(file)} is no longer where this test looks`).toBe(true);
    }
  });

  it("reaches the page from the entry, so the entry case is not trivially clean", () => {
    // A traversal that found nothing would reach no server module either, which
    // is the one shape of failure a guard must not have.
    const reached = reachableFrom(BROWSER_ENTRY).map(rel);
    expect(reached).toContain("src/App.tsx");
    expect(reached).toContain("src/lib/file-link.ts");
  });

  it("finds a chain when there is one", () => {
    // The complement: the route modules do reach the client, on purpose.
    expect(chainTo(join(APP_DIR, "src", "routes", "records.ts"), SERVER_ONLY)).not.toBeNull();
  });
});

describe("the browser bundle reaches no server-only module", () => {
  it("src/main.tsx — the whole of what ships to the browser", () => {
    const chain = chainTo(BROWSER_ENTRY, SERVER_ONLY);
    expect(
      chain === null,
      chain
        ? `the browser bundle reaches a server-only module:\n  ${chain.map(rel).join("\n→ ")}`
        : undefined,
    ).toBe(true);
  });

  it.each(
    // Checked individually so a failure names the file that introduced the
    // edge rather than only the entry.
    walk(join(APP_DIR, "src"))
      .filter((f) => f.endsWith(".tsx") || f === join(APP_DIR, "src", "lib", "file-link.ts"))
      .map((file) => [rel(file), file] as const),
  )("%s", (_name, file) => {
    const chain = chainTo(file, SERVER_ONLY);
    expect(
      chain === null,
      chain ? `import chain into a server-only module:\n  ${chain.map(rel).join("\n→ ")}` : undefined,
    ).toBe(true);
  });
});

describe("the marker it replaced", () => {
  it("is gone from the tree, rather than left in place enforcing nothing", () => {
    // `server-only` was a marker the previous bundler resolved and refused in a
    // client graph. There is no such package in this tree and the bundler that
    // ships the browser half now would not know the convention if there were:
    // an entry importing `drive-client.ts` would simply bundle `node:sqlite`
    // for the browser, with no error anywhere. The graph walk above is the
    // whole statement, so the marker must not come back — and the *words* still
    // appear in comments here and in `file-link.ts`, which is why this looks
    // for the import rather than the text.
    const marked = walk(join(APP_DIR, "src")).filter((file) =>
      /(?:^|\s)import\s*["']server-only["']/.test(readFileSync(file, "utf-8")),
    );
    expect(marked.map(rel)).toEqual([]);
  });
});
