/**
 * The edge where the real React Native modules meet the ports.
 *
 * ## Why this is the only file that imports them
 *
 * Everything else — the driver, the storage adapter, the node assembly, the job
 * graph — takes its dependencies as arguments and declares the shapes it needs
 * structurally. That is what lets all of it run in Node against fakes, which is
 * how a real sync exchange and a real residency budget got tested without a
 * handset.
 *
 * That property only survives if the real imports stay in one place. A single
 * `import { File } from "expo-file-system"` in the storage adapter would make
 * the adapter unloadable outside React Native, and its tests would have to be
 * rewritten around a mock loader — which is the point at which people stop
 * writing them.
 *
 * So: this file is untestable here, and it is the *only* file that is.
 */

import { open as openOpSqlite } from "@op-engineering/op-sqlite";
import { Directory, File, Paths } from "expo-file-system";
import { createOpSqliteDriver, type OpSqliteModule } from "./db/op-sqlite-driver";
import {
  ExpoObjectStorageAdapter,
  type ExpoDirectory,
  type ExpoFile,
  type ExpoFileSystem,
} from "./storage/expo-object-storage";

/**
 * op-sqlite, narrowed to the two calls the driver uses.
 *
 * The cast is the honest shape of this boundary: op-sqlite's own types describe
 * far more than the driver touches, and asserting the narrow contract here is
 * what keeps that surface from leaking inward. If op-sqlite changes either
 * call, this is the line that fails to compile — which is the right place for
 * it to fail.
 */
/**
 * Note what this file does *not* have to install: a SHA-256.
 *
 * The storage adapter verifies streamed writes against the record's content
 * hash, and used to do it with `node:crypto` at module scope — which does not
 * merely fail on React Native, it makes the whole package unbundleable there.
 * Its default is now a portable implementation, so the phone needs no wiring at
 * all and the *servers* opt into the faster native one instead. Correct by
 * default, fast where it is worth configuring.
 */

export const opSqliteModule: OpSqliteModule = {
  open: (options) => openOpSqlite(options) as unknown as ReturnType<OpSqliteModule["open"]>,
};

export const opSqliteDriver = createOpSqliteDriver(opSqliteModule);

/** expo-file-system's class API, adapted to the interface the storage adapter declares. */
export const expoFileSystem: ExpoFileSystem = {
  file: (path: string) => new File(path) as unknown as ExpoFile,
  directory: (path: string) => new Directory(path) as unknown as ExpoDirectory,
};

/**
 * Where the app's own data lives.
 *
 * `Paths.document` rather than a cache directory: the OS may delete a cache
 * without asking, and a phone that silently lost its local database would
 * re-sync the entire library on next launch — over the network, against a
 * budget, from a node that believed it already had everything.
 */
export function documentPath(...segments: string[]): string {
  return [Paths.document.uri.replace(/\/$/, ""), ...segments].join("/");
}

export const DATABASE_PATH = documentPath("starkeep", "local.sqlite");
export const OBJECTS_PATH = documentPath("starkeep", "objects");

export function createLocalObjectStorage(): ExpoObjectStorageAdapter {
  return new ExpoObjectStorageAdapter({ fs: expoFileSystem, basePath: OBJECTS_PATH });
}
