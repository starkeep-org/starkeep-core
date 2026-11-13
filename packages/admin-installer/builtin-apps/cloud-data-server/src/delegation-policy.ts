/**
 * What a delegation may call, by mode.
 *
 * An explicit allowlist keyed on method and path together, as for devices
 * (`deviceMayCall`), because some reads use POST. A route this list does not
 * name is refused, so a route added to the broker later stays closed to
 * outside clients until someone decides otherwise here.
 *
 * The mode narrows the app's grants and never widens them: past this check
 * the request runs as the app, and the app's grants apply as on any app call.
 *
 * The rules (plan-headless-delegated-access-2026-11-13.md, Decision 4):
 *
 * - `read` reads, and writes labels, as an app with only a `read` grant may.
 * - `readwrite` also writes records, files, metadata and app rows, and
 *   deletes by tombstone only: a record to the Trash, an app row to a
 *   tombstone. Both stay recoverable inside the retention window.
 * - No delegation erases bytes (`DELETE /files/<key>`,
 *   `DELETE /app-data/files/<key>`, `POST /data/reap`), restores from the
 *   archive, syncs, publishes a public share, or reads the stand-in backlog
 *   or the deployment's settings.
 */
import type { DelegationMode } from "@starkeep/protocol-primitives";

type Rule = readonly [method: string, path: RegExp];

const SEG = "[^/]+";
const KEY = ".+";

function rule(method: string, path: string): Rule {
  return [method, new RegExp(`^${path}$`)];
}

/** Calls that read, for both modes. */
const READS: readonly Rule[] = [
  rule("GET", "/data/types"),
  rule("GET", "/data/records"),
  rule("GET", `/data/records/${SEG}`),
  rule("GET", "/data/label-keys"),
  rule("GET", "/data/labels"),
  rule("GET", `/data/metadata/${SEG}`),
  rule("GET", `/data/records/${SEG}/metadata/${SEG}`),
  rule("GET", `/data/records/${SEG}/file-url`),
  rule("GET", `/data/records/${SEG}/content-url`),
  rule("POST", "/data/records/file-urls"),
  rule("GET", `/files/${KEY}/presign`),
  rule("GET", `/files/${KEY}/stat`),
  rule("HEAD", `/files/${KEY}`),
  rule("GET", `/app-data/db/${SEG}`),
  rule("GET", "/app-data/files"),
  rule("GET", `/app-data/files/${KEY}`),
  rule("POST", "/app-data/file-urls"),
];

/** Label writes, for both modes: tagging data changes no data. */
const LABEL_WRITES: readonly Rule[] = [
  rule("POST", "/data/labels"),
  rule("POST", "/data/labels/values"),
  rule("POST", "/data/labels/retract"),
];

/** Writes and tombstoning deletes, for `readwrite` only. */
const WRITES: readonly Rule[] = [
  rule("POST", "/data/records"),
  rule("POST", "/data/files"),
  rule("POST", "/files/presign"),
  rule("POST", "/files/presign-batch"),
  rule("POST", "/files/multipart/presign"),
  rule("POST", "/files/multipart/complete"),
  rule("POST", `/data/records/${SEG}/fidelity`),
  rule("POST", `/data/records/${SEG}/metadata`),
  rule("DELETE", `/data/records/${SEG}`),
  rule("POST", `/app-data/db/${SEG}`),
  rule("PATCH", `/app-data/db/${SEG}`),
  rule("DELETE", `/app-data/db/${SEG}`),
  rule("POST", "/app-data/files/presign"),
  rule("POST", `/app-data/files/${KEY}/record`),
];

/**
 * Routes no delegation reaches, matched before the lists above so that a
 * wide pattern there (`/files/<key>`, `/data/records/<id>`) can never admit
 * one of these by accident.
 */
const NEVER: readonly Rule[] = [
  rule("DELETE", `/files/${KEY}`),
  rule("DELETE", `/app-data/files/${KEY}`),
  rule("POST", "/data/reap"),
  rule("POST", `/data/records/${SEG}/restore`),
  rule("POST", "/sync/exchange"),
  rule("GET", "/data/stand-ins/backlog"),
  rule("GET", "/data/trash"),
];

function matches(rules: readonly Rule[], method: string, subPath: string): boolean {
  return rules.some(([m, p]) => m === method && p.test(subPath));
}

/** Whether a delegation in `mode` may call `method subPath` on an app's data. */
export function delegatedMayCall(mode: DelegationMode, method: string, subPath: string): boolean {
  if (subPath.includes("/public-shares")) return false;
  if (subPath.startsWith("/deployment/")) return false;
  if (matches(NEVER, method, subPath)) return false;
  if (matches(READS, method, subPath) || matches(LABEL_WRITES, method, subPath)) return true;
  return mode === "readwrite" && matches(WRITES, method, subPath);
}

/** Whether an admitted call changes data, for the row's `last_write_at_ms`. */
export function isDelegatedWrite(method: string, subPath: string): boolean {
  return matches(WRITES, method, subPath) || matches(LABEL_WRITES, method, subPath);
}
