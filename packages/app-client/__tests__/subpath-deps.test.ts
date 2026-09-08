/**
 * `@starkeep/app-client/web` and `/lambda` must not drag the AWS SDK into an
 * app's Lambda zip.
 *
 * The package as a whole depends on `@aws-sdk/client-ssm` for the credential
 * loader, and every browser-facing app bundles the web adapter into its shell.
 * One import edge from `web.ts` back to `credentials.ts` would put the SSM
 * client in front of every cold start of every app that adopted the adapter —
 * which is the same class of regression the adapter exists to prevent, arriving
 * from the other direction.
 *
 * The source graph is what is asserted, because that is where the mistake is
 * made. The built output is checked too when `dist/` is present, so a change to
 * the bundler's splitting behavior cannot reintroduce the edge silently.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every module specifier `file` imports, static and dynamic alike.
 *
 * Comments are stripped first: both subpaths document their usage with a code
 * example that imports an app's own entry, and a scanner that read those would
 * be asserting against the documentation rather than against the graph.
 */
function importsOf(file: string): string[] {
  const source = stripComments(readFileSync(file, "utf8"));
  const specifiers: string[] = [];
  const patterns = [
    /(?:^|[\s;}])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g,
    /(?:^|[\s;}])import\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    for (const match of source.matchAll(re)) specifiers.push(match[1]!);
  }
  return specifiers;
}

/** Transitively resolve a source entry's relative imports; collect the rest. */
function sourceGraph(entry: string): { files: string[]; external: string[] } {
  const files: string[] = [];
  const external = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (files.includes(file)) continue;
    files.push(file);
    for (const spec of importsOf(file)) {
      if (!spec.startsWith(".")) {
        external.add(spec);
        continue;
      }
      // Source is written with the `.js` extension ESM requires at runtime.
      const target = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
      if (existsSync(target)) queue.push(target);
      else external.add(spec);
    }
  }
  return { files, external: [...external] };
}

const NODE_BUILTIN = /^node:/;

describe("the lambda and web subpaths carry no runtime dependencies", () => {
  it("imports nothing outside node builtins from src/lambda.ts", () => {
    const { files, external } = sourceGraph(resolve(PKG_DIR, "src", "lambda.ts"));
    expect(files.map((f) => f.slice(PKG_DIR.length + 1))).toEqual(["src/lambda.ts"]);
    expect(external).toEqual([]);
  });

  it("imports nothing outside node builtins from src/web.ts", () => {
    const { files, external } = sourceGraph(resolve(PKG_DIR, "src", "web.ts"));
    // The whole graph, spelled out: the adapter composes with the entry helper
    // and nothing else. A new file here is a decision worth making on purpose.
    expect(files.map((f) => f.slice(PKG_DIR.length + 1)).sort()).toEqual([
      "src/lambda.ts",
      "src/web.ts",
    ]);
    expect(external.filter((s) => !NODE_BUILTIN.test(s))).toEqual([]);
  });

  it("never reaches credentials.ts, which is what pulls in the AWS SDK", () => {
    for (const entry of ["lambda.ts", "web.ts"]) {
      const { files } = sourceGraph(resolve(PKG_DIR, "src", entry));
      expect(files.some((f) => f.endsWith("credentials.ts"))).toBe(false);
    }
  });

  it("ships built subpaths whose whole chunk graph imports no package", () => {
    // The chunks matter as much as the entry. Chunk splitting is on, so a
    // subpath can be free of the AWS SDK in its own file and reach it one
    // `./chunk-*.js` hop away — which is the shape a check that stopped at the
    // entry would call clean.
    for (const built of ["dist/lambda.js", "dist/web.js"]) {
      const entry = resolve(PKG_DIR, built);
      if (!existsSync(entry)) continue; // `pnpm build` has not run in this tree.
      const seen: string[] = [];
      const queue = [entry];
      while (queue.length > 0) {
        const file = queue.shift()!;
        if (seen.includes(file)) continue;
        seen.push(file);
        for (const spec of importsOf(file)) {
          if (spec.startsWith(".")) {
            queue.push(resolve(dirname(file), spec));
            continue;
          }
          expect(
            NODE_BUILTIN.test(spec) || isBareNodeBuiltin(spec),
            `${built} reaches ${spec} via ${file.slice(PKG_DIR.length + 1)}`,
          ).toBe(true);
        }
      }
      for (const file of seen) {
        const source = readFileSync(file, "utf8");
        expect(source, `${file.slice(PKG_DIR.length + 1)} carries the SSM client`).not.toContain(
          "SSMClient",
        );
      }
    }
  });
});

/** Drop block and line comments, leaving string contents alone. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The bundler emits `fs/promises` rather than `node:fs/promises`. */
function isBareNodeBuiltin(spec: string): boolean {
  const root = spec.split("/")[0]!;
  return [
    "assert",
    "buffer",
    "crypto",
    "fs",
    "http",
    "https",
    "module",
    "os",
    "path",
    "stream",
    "url",
    "util",
    "zlib",
  ].includes(root);
}
