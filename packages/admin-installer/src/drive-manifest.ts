/**
 * Starkeep Drive's built-in manifest. A module of its own so that the CLI can
 * read it without loading the installer and Pulumi.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appManifestSchema } from "@starkeep/admin-manifest";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to the Starkeep Drive built-in app directory (manifest only — no compute). */
export function drivePackageDir(): string {
  // src/ → ../builtin-apps/starkeep-drive/
  return resolve(__dirname, "..", "builtin-apps", "starkeep-drive");
}

/**
 * Load and validate the Starkeep Drive manifest. Parsing through
 * `appManifestSchema` fills the schema defaults (compute disabled, no
 * app-specific syncable tables) so `installApp` sees a fully-shaped manifest.
 *
 * Drive's `"compute": { "enabled": false }` is load-bearing and is the ONLY
 * reason it looks exempt from the app-authentication work. It is a full cloud
 * principal — the always-on Drive sync channel ships every shared record the
 * user owns to `/apps/starkeep-drive/*` — and it holds `fileAccessAll` and the
 * User-Data-Owner boundary. It simply has no Lambda, so it has no anonymous
 * surface for anyone to reach.
 *
 * If Drive ever gains compute it becomes structurally identical to Photos and
 * Memo, and worse: an unauthenticated Drive leaks everything the user owns
 * rather than one library. That manifest change is an event requiring the
 * reachability pass in `docs/reachability-review-requirement.md`, not a routine edit.
 * `__tests__/drive-manifest.test.ts` fails the day the flag flips, so this is
 * not left to whoever happens to read the JSON.
 *
 * A platform update compares this manifest with the one the cloud's Drive
 * row recorded, so this module imports nothing heavy.
 */
export function loadDriveManifest() {
  const path = join(drivePackageDir(), "manifest.json");
  return appManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
