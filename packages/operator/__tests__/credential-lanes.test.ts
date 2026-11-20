/**
 * Only the bootstrap stack uses the terminal's AWS credentials (decision 8 of
 * the CLI design). Every other AWS client in the operator package and the CLI
 * must be handed the admin's credentials; a client built without them would
 * fall back to the SDK's default chain, which is the terminal's profile.
 *
 * `src/bootstrap.ts` is the one module that may build a client without
 * credentials. Cloud work in the installer runs in a child process whose
 * environment holds only the admin's credentials (`installerEnv`), so it is
 * outside this check.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOTS = [resolve(HERE, "..", "src"), resolve(HERE, "..", "..", "cli", "src")];
const OWNER_LANE = resolve(HERE, "..", "src", "bootstrap.ts");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

/** The text between the parentheses of each AWS client construction in `text`. */
function clientConstructions(text: string): Array<{ name: string; args: string }> {
  const out: Array<{ name: string; args: string }> = [];
  for (const match of text.matchAll(/new\s+(\w+Client|DsqlSigner)\s*\(/g)) {
    let depth = 1;
    let i = match.index! + match[0].length;
    const start = i;
    while (i < text.length && depth > 0) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
      i++;
    }
    out.push({ name: match[1]!, args: text.slice(start, i - 1) });
  }
  return out;
}

describe("the credential lanes", () => {
  it("hands the admin's credentials to every AWS client outside the owner lane", () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        if (file === OWNER_LANE) continue;
        for (const c of clientConstructions(readFileSync(file, "utf8"))) {
          seen++;
          if (!/\bcredentials\b/.test(c.args))
            offenders.push(`${relative(HERE, file)}: new ${c.name}(…)`);
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it("keeps the CLI from importing an AWS client package at all", () => {
    const cliFiles = sourceFiles(ROOTS[1]!);
    const imports = cliFiles.filter((f) => /from "@aws-sdk\//.test(readFileSync(f, "utf8")));
    expect(imports.map((f) => relative(HERE, f))).toEqual([]);
  });

  it("finds the owner lane's own clients, so the exception is real", () => {
    expect(clientConstructions(readFileSync(OWNER_LANE, "utf8")).length).toBeGreaterThan(0);
  });
});
