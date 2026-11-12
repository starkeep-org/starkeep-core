// Shared helpers for the AI-684 Pulumi spike: the emulator environment, a
// step recorder, and the emulator's generated keys.

import { readFileSync } from "node:fs";

export const REGION = "us-east-1";

/** Refuse to run unless every AWS call this process makes goes to the local emulator. */
export function requireEmulatorEnv() {
  const endpoint = process.env.AWS_ENDPOINT_URL ?? "";
  if (!/^https:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) {
    throw new Error(`AWS_ENDPOINT_URL must be https://127.0.0.1:<port>, got "${endpoint}"`);
  }
  for (const name of [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "STARKEEP_AWS_TESTS",
  ]) {
    if (process.env[name]) throw new Error(`${name} is set; run through run.sh`);
  }
  for (const name of ["AWS_SHARED_CREDENTIALS_FILE", "NODE_EXTRA_CA_CERTS", "SPIKE_WORK"]) {
    if (!process.env[name]) throw new Error(`${name} is not set; run through run.sh`);
  }
  return {
    endpoint,
    caFile: process.env.NODE_EXTRA_CA_CERTS,
    work: process.env.SPIKE_WORK,
  };
}

/** The key pair the emulator generated for this run (never printed). */
export function emulatorKeys() {
  const text = readFileSync(process.env.AWS_SHARED_CREDENTIALS_FILE, "utf8");
  const get = (k) => text.match(new RegExp(`^\\s*${k}\\s*=\\s*(\\S+)`, "m"))?.[1];
  const accessKeyId = get("aws_access_key_id");
  const secretAccessKey = get("aws_secret_access_key");
  if (!accessKeyId || !secretAccessKey) throw new Error("no keys in the emulator credentials file");
  return { accessKeyId, secretAccessKey };
}

/** One-line description of an error, emulator message included. */
export function describeError(err) {
  if (!err) return String(err);
  const name = err.name && err.name !== "Error" ? `${err.name}: ` : "";
  const status = err.$metadata?.httpStatusCode ? ` (HTTP ${err.$metadata.httpStatusCode})` : "";
  return `${name}${String(err.message ?? err).split("\n")[0]}${status}`;
}

/** Collects one row per step: { section, step, outcome, ms, detail }. */
export function recorder() {
  const rows = [];
  async function step(section, name, fn) {
    const start = performance.now();
    try {
      const { outcome = "ok", detail = "", value } = (await fn()) ?? {};
      rows.push({
        section,
        step: name,
        outcome,
        ms: Math.round(performance.now() - start),
        detail,
      });
      return value;
    } catch (err) {
      rows.push({
        section,
        step: name,
        outcome: "failed",
        ms: Math.round(performance.now() - start),
        detail: describeError(err),
      });
      return undefined;
    }
  }
  function add(row) {
    rows.push({ ms: "", detail: "", ...row });
  }
  return { rows, step, add };
}

/** Never print a secret; keep everything else. */
export function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets) if (s) out = out.split(s).join("<redacted>");
  return out;
}
