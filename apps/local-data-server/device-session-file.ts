/**
 * This machine's sign-in, at rest: `~/.starkeep/device-session.json`.
 *
 * The file holds a ten-year refresh token from the pool's device client, so it
 * is written `0600` and re-tightened after every write — `writeFile` applies a
 * mode only when it creates the file. ID tokens are never written; they live
 * fifteen minutes and are re-obtained on demand.
 *
 * Besides the session the file keeps three things a fresh process needs before
 * it can reach the network:
 *
 * - **How to reach the pool** (`auth`): the region, pool and device client the
 *   token belongs to. A refresh token is only good with its own client, and a
 *   member's machine learned these from the cloud's `/auth/config` rather than
 *   from its config file.
 * - **Whose session it is** (`userId`): the token's `sub`, so a machine that
 *   starts offline can tell its library is bound to the signed-in user and
 *   start sync without waiting for a refresh.
 * - **A sign-out still waiting on its pool** (`pendingRevocation`): the token
 *   and the pool that issued it, so a retry after a move to another cloud
 *   still reaches the right pool.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  DeviceAuthConfig,
  PendingRevocation,
  SessionStore,
  StoredSession,
} from "@starkeep/protocol-primitives";

export const DEVICE_SESSION_FILE = "device-session.json";

interface FileShape {
  auth: DeviceAuthConfig | null;
  userId: string | null;
  session: StoredSession | null;
  pendingRevocation: PendingRevocation | null;
}

const EMPTY: FileShape = { auth: null, userId: null, session: null, pendingRevocation: null };

export interface DeviceSessionFile {
  /** The session store the shared sign-in code reads and writes. */
  readonly store: SessionStore;
  /** The pool the stored session belongs to, or null before any sign-in. */
  auth(): DeviceAuthConfig | null;
  /** The signed-in user's id, or null when signed out. */
  userId(): string | null;
  /** Record a completed sign-in: the pool, the user, and the session. */
  writeSignIn(auth: DeviceAuthConfig, userId: string, session: StoredSession): void;
}

export function openDeviceSessionFile(starkeepDir: string): DeviceSessionFile {
  const path = join(starkeepDir, DEVICE_SESSION_FILE);

  function read(): FileShape {
    if (!existsSync(path)) return { ...EMPTY };
    try {
      return { ...EMPTY, ...(JSON.parse(readFileSync(path, "utf8")) as Partial<FileShape>) };
    } catch {
      // A torn or hand-edited file is a signed-out machine, not a crash.
      return { ...EMPTY };
    }
  }

  function write(next: FileShape): void {
    mkdirSync(starkeepDir, { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
    chmodSync(path, 0o600);
  }

  function update(change: (current: FileShape) => FileShape): void {
    write(change(read()));
  }

  const store: SessionStore = {
    async read() {
      return read().session;
    },
    async write(session) {
      update((f) => ({ ...f, session }));
    },
    async clear() {
      update((f) => ({ ...f, session: null, userId: null }));
    },
    async readPendingRevocation() {
      return read().pendingRevocation;
    },
    async writePendingRevocation(pending) {
      update((f) => ({ ...f, pendingRevocation: pending }));
    },
    async clearPendingRevocation() {
      update((f) => ({ ...f, pendingRevocation: null }));
    },
  };

  return {
    store,
    auth: () => read().auth,
    userId: () => read().userId,
    writeSignIn(auth, userId, session) {
      update((f) => ({ ...f, auth, userId, session }));
    },
  };
}
