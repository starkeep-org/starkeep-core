/** An in-memory {@link SessionStore}: what a `0600` file or the secure store holds. */
import type { PendingRevocation, SessionStore, StoredSession } from "../../src/index.js";

export function memorySessionStore(): SessionStore {
  let session: StoredSession | null = null;
  let pending: PendingRevocation | null = null;
  return {
    async read() {
      return session;
    },
    async write(next) {
      session = next;
    },
    async clear() {
      session = null;
    },
    async readPendingRevocation() {
      return pending;
    },
    async writePendingRevocation(next) {
      pending = next;
    },
    async clearPendingRevocation() {
      pending = null;
    },
  };
}
