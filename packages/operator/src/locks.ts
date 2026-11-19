/**
 * One holder at a time per scope, across the CLI and admin-web.
 *
 * A lock is the file `~/.starkeep/locks/<scope>.lock`, created with `wx` so
 * only one process wins, holding the holder's pid and command. A lock whose
 * pid no longer lives is stale, because its holder crashed, and the next
 * caller takes it over.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";
import { isAlive } from "./daemons";

export interface LockHolder {
  pid: number;
  command: string;
  since: string;
}

export function lockFile(scope: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(scope)) throw new Error(`Invalid lock scope "${scope}"`);
  return join(starkeepDir(), "locks", `${scope}.lock`);
}

/** The live holder of `scope`, or null when the lock is free or stale. */
export function lockHolder(scope: string): LockHolder | null {
  try {
    const holder = JSON.parse(readFileSync(lockFile(scope), "utf8")) as LockHolder;
    return Number.isInteger(holder.pid) && isAlive(holder.pid) ? holder : null;
  } catch {
    return null;
  }
}

export type LockResult = { ok: true; release: () => void } | { ok: false; holder: LockHolder };

/** Take `scope`'s lock for this process, or name the process that holds it. */
export function acquireLock(scope: string, command: string): LockResult {
  const path = lockFile(scope);
  mkdirSync(join(starkeepDir(), "locks"), { recursive: true, mode: 0o700 });
  const holder: LockHolder = { pid: process.pid, command, since: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify(holder), { flag: "wx", mode: 0o600 });
      let released = false;
      return {
        ok: true,
        release: () => {
          if (released) return;
          released = true;
          // Only remove the file while it still names this process.
          try {
            const now = JSON.parse(readFileSync(path, "utf8")) as LockHolder;
            if (now.pid === process.pid) unlinkSync(path);
          } catch {
            /* already gone */
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const current = lockHolder(scope);
      if (current) return { ok: false, holder: current };
      // Stale: the holder died without releasing. Remove the file and try once more.
      try {
        unlinkSync(path);
      } catch {
        /* another process removed it first */
      }
    }
  }
  const current = lockHolder(scope);
  return current
    ? { ok: false, holder: current }
    : { ok: false, holder: { pid: -1, command: "unknown", since: "" } };
}
