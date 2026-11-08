#!/usr/bin/env node
/**
 * The root `preinstall` check: a `pnpm` command must be on PATH.
 *
 * The root `postinstall` runs `turbo run build`, and turbo finds the package
 * manager by looking up `pnpm` on PATH. `corepack pnpm install` runs pnpm
 * without putting a `pnpm` command there, and turbo then fails with "Unable
 * to find package manager binary" (#143). This check fails first, with a
 * message that names the fix. It runs before dependencies exist, so it uses
 * Node built-ins only.
 */

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

const names = process.platform === "win32" ? ["pnpm.cmd", "pnpm.exe", "pnpm"] : ["pnpm"];

function onPath() {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      try {
        accessSync(join(dir, name), constants.X_OK);
        return true;
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return false;
}

if (!onPath()) {
  console.error(
    "\nstarkeep-core needs a `pnpm` command on your PATH: the install's build step\n" +
      "runs turbo, which looks pnpm up there. Install one with `npm install -g pnpm@10`,\n" +
      "or run `corepack enable pnpm`, then run `pnpm install` again.\n",
  );
  process.exit(1);
}
