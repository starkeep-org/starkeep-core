// The endpoint and credential guards from the runtime spike (AI-679), a fetch
// guard, and the per-step recorder (as in ../s3-ssm/lib.mjs, plus redaction:
// this spike handles tokens, passwords and vended keys, and none of them may
// reach the report).

import { existsSync } from "node:fs";

/** Refuse to run unless every SDK request can only reach a loopback emulator. */
export function guardEnvironment() {
  const endpoint = process.env.AWS_ENDPOINT_URL ?? "";
  if (!/^https:\/\/127\.0\.0\.1:\d+\/?$/.test(endpoint)) {
    fail(`AWS_ENDPOINT_URL must be https://127.0.0.1:<port>, got "${endpoint}"`);
  }
  // A service-specific endpoint variable would win over AWS_ENDPOINT_URL for that service.
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("AWS_ENDPOINT_URL_")) fail(`${name} is set; unset it`);
  }
  for (const name of [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_ROLE_ARN",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "STARKEEP_AWS_TESTS",
  ]) {
    if (process.env[name])
      fail(`${name} is set; unset it so only the emulator's own keys are used`);
  }
  const file = process.env.AWS_SHARED_CREDENTIALS_FILE ?? "";
  if (!existsSync(file)) fail(`AWS_SHARED_CREDENTIALS_FILE "${file}" does not exist`);
  return endpoint.replace(/\/$/, "");
}

export function fail(message) {
  console.error(`[spike] ${message}`);
  process.exit(2);
}

/**
 * Wrap `globalThis.fetch` so that nothing in this process can reach a host
 * other than 127.0.0.1. The product code that uses `fetch` (the device client,
 * app-client's refresh and JWKS fetch) builds some URLs from the public
 * Cognito host; those requests are refused here, before any socket opens, and
 * logged so the report can say exactly which URL the code tried.
 */
export function guardFetch() {
  const realFetch = globalThis.fetch;
  const log = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input.url ?? String(input));
    const host = new URL(url).hostname;
    const allowed = host === "127.0.0.1";
    log.push({ url, allowed });
    if (!allowed) {
      throw new Error(`refused by the spike's fetch guard (not 127.0.0.1): ${url}`);
    }
    return realFetch(input, init);
  };
  return log;
}

/** The exact error as the caller sees it: class name, code, message, HTTP status. */
export function describeError(err) {
  const status = err?.$metadata?.httpStatusCode ?? (err?.status || undefined);
  const cause = err?.cause?.code ?? err?.cause?.message;
  const code = err?.code && err.code !== err.name ? err.code : undefined;
  return [
    `${err?.name ?? "Error"}${code ? ` (${code})` : ""}: ${redactText(err?.message ?? String(err))}`,
    status ? `HTTP ${status}` : null,
    cause ? `cause ${cause}` : null,
  ]
    .filter(Boolean)
    .join("; ");
}

/** A secret's shape only: a JWT as `<JWT, n chars>`, anything else as its length and prefix. */
export function shape(value) {
  if (typeof value !== "string") return String(value);
  if (/^eyJ[\w-]*\.[\w-]*\.[\w-]*$/.test(value)) return `<JWT, ${value.length} chars>`;
  return `<${value.length} chars>`;
}

/** An access key id's prefix (the part that says what issued it) and length. */
export function keyIdShape(value) {
  if (typeof value !== "string") return String(value);
  return `${value.slice(0, 8)}… (${value.length} chars)`;
}

const SECRET_KEY =
  /token|secret|password|session$|^session|^accesskeyid$|^credentials$|refresh|^jwt$/i;

function redactText(text) {
  return String(text).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, (t) => shape(t));
}

/** JSON with every secret-looking field replaced by its shape. */
export function redact(value) {
  return JSON.stringify(value, (key, v) => {
    if (key && SECRET_KEY.test(key) && v !== null && typeof v === "object") return "<redacted>";
    if (key && SECRET_KEY.test(key) && typeof v === "string") return shape(v);
    if (typeof v === "string") return redactText(v);
    return v;
  });
}

/**
 * Collects one row per step. `check` receives the step's result and returns
 * null when it matches what AWS does, or a string saying how it differs.
 *
 * Outcomes: "ok" (succeeded and matched AWS; for a refusal check, refused as
 * AWS does), "differs" (succeeded, but the behaviour differs from AWS,
 * including accepting what AWS refuses), "failed" (threw where AWS succeeds,
 * or where starkeep code cannot be pointed at the emulator).
 *
 * `show` turns a successful result into the detail column. The default
 * redacts anything that looks like a token, password or key.
 */
export class Recorder {
  constructor() {
    this.rows = [];
    this.area = "setup";
  }

  section(area) {
    this.area = area;
  }

  async op(op, fn, check = () => null, show = summarize) {
    const started = performance.now();
    let result;
    try {
      result = await fn();
    } catch (err) {
      this.rows.push({
        area: this.area,
        op,
        outcome: "failed",
        ms: ms(started),
        detail: describeError(err),
      });
      return undefined;
    }
    const elapsed = ms(started);
    let difference;
    try {
      difference = check(result);
    } catch (err) {
      difference = `check threw: ${describeError(err)}`;
    }
    this.rows.push({
      area: this.area,
      op,
      outcome: difference ? "differs" : "ok",
      ms: elapsed,
      detail: difference ? `${difference} | ${show(result)}` : show(result),
    });
    return result;
  }

  /** A call AWS refuses: ok if it throws, "differs" if the emulator lets it through. */
  async refused(op, fn, awsSays, expect = () => null) {
    return this.op(
      op,
      async () => {
        try {
          const value = await fn();
          return { accepted: true, value };
        } catch (err) {
          return { accepted: false, error: describeError(err), err };
        }
      },
      (r) => (r.accepted ? `accepted; AWS refuses with ${awsSays}` : expect(r.err)),
      (r) => (r.accepted ? `accepted: ${summarize(r.value)}` : `refused: ${r.error}`),
    );
  }

  /** A row for a fact established without a call (read from source, say). */
  note(op, outcome, detail) {
    this.rows.push({ area: this.area, op, outcome, ms: 0, detail });
  }

  aborted(err) {
    this.rows.push({
      area: this.area,
      op: "driver aborted (error outside a step)",
      outcome: "failed",
      ms: 0,
      detail: `${describeError(err)} ${redactText(err?.stack?.split("\n")[1]?.trim() ?? "")}`,
    });
    process.exitCode = 1;
  }

  emit(extra = {}) {
    console.log(JSON.stringify({ rows: this.rows, ...extra }));
  }
}

function ms(started) {
  return Math.round(performance.now() - started);
}

export function summarize(result) {
  if (result === undefined) return "";
  const text = typeof result === "string" ? redactText(result) : redact(result);
  return text.length > 400 ? `${text.slice(0, 397)}...` : text;
}

/** `label: got X, AWS gives Y` for each pair that differs; null when all match. */
export function diffs(pairs) {
  const out = [];
  for (const [label, actual, expected] of pairs) {
    const a = canonical(actual);
    const e = canonical(expected);
    if (a !== e) out.push(`${label}: got ${a ?? "absent"}, expected ${e}`);
  }
  return out.length ? out.join("; ") : null;
}

/** JSON with object keys sorted, so key order never counts as a difference. */
function canonical(value) {
  return JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
}

/** Header and payload of a JWT, decoded and not verified. */
export function decodeJwt(token) {
  const [h, p] = token.split(".");
  const json = (s) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
  return { header: json(h), payload: json(p) };
}
