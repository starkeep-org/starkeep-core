import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import dotenv from "dotenv";

/**
 * Load `STARKEEP_DIR` (and any other vars) from a repo-root `.env` file so that
 * dropping `STARKEEP_DIR=...` in a dotfile actually switches which local instance
 * a launch targets — the convenience layer over the always-supported "export it
 * in the environment" path.
 *
 * Precedence (highest wins): an already-exported `process.env` value >
 * `.env.local` > `.env`. This is achieved with `override: false` on every load,
 * so an existing key is never clobbered: loading `.env.local` first claims the
 * keys it sets, then `.env` only fills the gaps, and anything the caller exported
 * (e.g. `STARKEEP_DIR=... pnpm dev`, or a test harness) always takes priority.
 *
 * The single repo-root file is the source of truth all consumers load — the
 * local-data-server, the tsx CLIs, the shell scripts (via `scripts/load-env.sh`),
 * and admin-web (via `next.config.ts`).
 */
export function loadStarkeepEnv(root: string = resolveEnvRoot()): void {
  // `.env.local` first so it wins over `.env`; `override: false` keeps any
  // already-exported value ahead of both.
  for (const file of [".env.local", ".env"]) {
    const path = join(root, file);
    if (existsSync(path)) {
      dotenv.config({ path, override: false, quiet: true });
    }
  }
}

/**
 * The directory to look for `.env` / `.env.local` in. Defaults to the repo root,
 * discovered by walking up from the launching process's cwd until
 * `pnpm-workspace.yaml` is found — every consumer is launched from somewhere
 * inside the monorepo (repo root, an app dir, or a package dir), so this resolves
 * to the same root regardless of which one. The `STARKEEP_ENV_DIR` override
 * exists for tests (point it at a throwaway dir) and is harmless in production.
 */
function resolveEnvRoot(): string {
  const override = process.env.STARKEEP_ENV_DIR;
  if (override) return resolve(override);
  return findRepoRoot(process.cwd());
}

function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start; // hit filesystem root; fall back
    dir = parent;
  }
}
