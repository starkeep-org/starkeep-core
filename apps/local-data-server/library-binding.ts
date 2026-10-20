/**
 * Binding this machine's library to its user: the file half, on the local
 * filesystem. The database half, and the reasons for both, are in
 * `@starkeep/storage-sqlite`'s `library-owner.ts`.
 *
 * See `~/projects/starkeep/plan-multi-user-roles-2026-10-16.md`, step 4.9.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import type { RawDatabase } from "@starkeep/storage-adapter";
import { LOCAL_USER_SEGMENT } from "@starkeep/protocol-primitives";
import { checkLibraryBindable, commitLibraryBinding } from "@starkeep/storage-sqlite";

export {
  boundUserId,
  libraryUserSegment,
  LibraryBoundElsewhereError,
} from "@starkeep/storage-sqlite";

/**
 * Move `<from>` to `<to>`, merging into `<to>` when it exists. A file already
 * at its destination stays, because keys are content-addressed or app-named:
 * the same key holds the same bytes. Returns whether anything moved.
 */
function mergeDir(from: string, to: string): boolean {
  if (!existsSync(from)) return false;
  if (!existsSync(to)) {
    renameSync(from, to);
    return true;
  }
  let moved = false;
  for (const name of readdirSync(from)) {
    const source = join(from, name);
    const target = join(to, name);
    if (lstatSync(source).isDirectory() && existsSync(target)) {
      if (mergeDir(source, target)) moved = true;
    } else if (!existsSync(target)) {
      renameSync(source, target);
      moved = true;
    }
  }
  // Left behind only when a duplicate stayed; the next sweep tries again.
  if (readdirSync(from).length === 0) rmdirSync(from);
  return moved;
}

export interface BindReport {
  readonly userId: string;
  readonly movedDirs: number;
  readonly rewrittenKeys: number;
}

/**
 * Bind the library to `userId`: rename the `local` segment in the object
 * store and in every stored key, then store the user. Refuses a library bound
 * to someone else. For a library already bound to `userId`, sweeps up anything
 * still under `local`.
 */
export function bindLibrary(db: RawDatabase, objectsDir: string, userId: string): BindReport {
  checkLibraryBindable(db, userId);

  let movedDirs = 0;
  mkdirSync(join(objectsDir, "shared"), { recursive: true });
  if (mergeDir(join(objectsDir, "shared", LOCAL_USER_SEGMENT), join(objectsDir, "shared", userId)))
    movedDirs += 1;
  const appsDir = join(objectsDir, "apps");
  if (existsSync(appsDir)) {
    for (const appId of readdirSync(appsDir)) {
      if (mergeDir(join(appsDir, appId, LOCAL_USER_SEGMENT), join(appsDir, appId, userId)))
        movedDirs += 1;
    }
  }

  const rewrittenKeys = commitLibraryBinding(db, userId);
  return { userId, movedDirs, rewrittenKeys };
}
