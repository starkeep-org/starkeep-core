/**
 * Which manifest a person approved, checked against the manifest an install
 * is about to use.
 *
 * Admin's install and update dialogs show a manifest and send it with the
 * request. The routes install only when the app's folder still holds that
 * manifest, so a folder that changed after the dialog, for example through a
 * `git pull` in another terminal, never installs unseen. The cloud route also
 * hands the CLI the approved manifest's digest, and the CLI refuses a folder
 * that changed between the route's check and its own read.
 *
 * Both sides compare validated manifests. A folder holds the raw manifest,
 * while the local registry and the dialogs may hold the validated one with
 * its defaults filled in, so raw text would differ where the content does not.
 */

import { createHash } from "node:crypto";
import { validateManifest, type AppManifest } from "@starkeep/admin-manifest";

/** JSON with every object's keys sorted, so key order never matters. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : v,
  );
}

/** Whether `approved`, as a dialog sent it, is the manifest `manifest` validates to. */
export function approvesManifest(approved: unknown, manifest: AppManifest): boolean {
  const validated = validateManifest(approved).manifest;
  return validated != null && canonicalJson(validated) === canonicalJson(manifest);
}

/** A digest of a validated manifest's content, for the CLI to check against. */
export function manifestDigest(manifest: AppManifest): string {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}
