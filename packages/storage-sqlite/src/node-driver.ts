/**
 * The Node driver, and the only file in this package that names `node:sqlite`.
 *
 * ## Why it is not in the barrel
 *
 * A static `import { DatabaseSync } from "node:sqlite"` at module scope does not
 * merely fail on React Native — it makes the whole package unbundleable there.
 * Metro resolves the import graph eagerly, so the specifier has to resolve even
 * when nothing calls the thing behind it. Injecting an op-sqlite driver does not
 * help: by the time the adapter is constructed, the barrel has already dragged
 * `node:sqlite` in.
 *
 * That is the same failure `@starkeep/storage-adapter` had with `node:crypto`
 * for its content hashing, and the resolution is the same in spirit: the shared
 * entry point stays portable, and the platform-specific implementation is
 * something a Node caller opts into. The difference is that a SHA-256 has a
 * portable default and a SQLite connection does not, so this cannot be a default
 * at all — hence `driver` being a required option rather than one with a
 * fallback that only works on half the platforms.
 *
 * Import it from `@starkeep/storage-sqlite/node`. The main entry has no `node:`
 * imports and is safe to bundle for a handset.
 */

import type { RawDatabase } from "@starkeep/storage-adapter";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { SqliteDriver } from "./adapter.js";

/** Node's built-in SQLite. The default everywhere except React Native. */
export const nodeSqliteDriver: SqliteDriver = {
  open: (path) => {
    // Node's SQLite will not create a missing parent directory, so this driver
    // must. op-sqlite manages its own location and does not want this done for
    // it — which is why it lives here rather than in the adapter.
    if (path !== ":memory:") {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    return new DatabaseSync(path);
  },
  close: (db) => (db as unknown as DatabaseSync).close(),
};
