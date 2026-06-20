import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/**
 * The one true root for all local Starkeep on-disk state: `data.db`,
 * `config.json`, `app-creds/`, `objects/`, `watches.json`, auth/cloud creds.
 *
 * `STARKEEP_DIR` is the single knob — what the local-data-server (the process
 * that owns and writes this directory) has always used. Every other component
 * (CLIs, admin-web, Drive) resolves the same root through here, so config.json
 * and data.db can never drift apart.
 */
export function starkeepDir(): string {
  const dir = process.env.STARKEEP_DIR ?? join(homedir(), ".starkeep");
  assertNotRealStateUnderTest(dir);
  return dir;
}

/**
 * Under a test runner, refuse to ever resolve to the operator's *real*
 * `~/.starkeep`. The production default is intentionally `~/.starkeep`, so this
 * can only be active in tests — it keys off `VITEST` (set automatically by
 * Vitest in-process and inherited by spawned child processes) or an explicit
 * `STARKEEP_TEST_GUARD=1` that the Playwright e2e harness sets in its config.
 *
 * This turns the "every test must remember to point STARKEEP_DIR at a throwaway
 * dir" convention into an enforced invariant: a harness that forgets to set the
 * env var (or a regression in this default) now fails loudly instead of
 * silently reading/writing/deleting the developer's live local state.
 */
function assertNotRealStateUnderTest(dir: string): void {
  const underTest = process.env.VITEST || process.env.STARKEEP_TEST_GUARD === "1";
  if (!underTest) return;
  const real = resolve(join(homedir(), ".starkeep"));
  const resolved = resolve(dir);
  if (resolved === real || resolved.startsWith(real + sep)) {
    throw new Error(
      `Refusing to use the operator's real Starkeep state directory (${real}) under a test ` +
        `runner: STARKEEP_DIR resolved to ${resolved}. Point STARKEEP_DIR at a throwaway ` +
        `directory (e.g. an mkdtemp dir or the e2e-aws/.run/<prefix> dir).`,
    );
  }
}

export const configPath = (): string => join(starkeepDir(), "config.json");
export const dataDbPath = (): string => join(starkeepDir(), "data.db");
export const appCredsPath = (appId: string): string =>
  join(starkeepDir(), "app-creds", `${appId}.json`);
