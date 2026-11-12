// Shared by s3.mjs and ssm.mjs: the endpoint and credential guards from the
// runtime spike (AI-679), the emulator's key pair, and the per-operation recorder.

import { existsSync, readFileSync } from "node:fs";

/** Refuse to run unless every request can only reach a loopback emulator. */
export function guardEnvironment() {
  const endpoint = process.env.AWS_ENDPOINT_URL ?? "";
  if (!/^https:\/\/127\.0\.0\.1:\d+\/?$/.test(endpoint)) {
    fail(`AWS_ENDPOINT_URL must be https://127.0.0.1:<port>, got "${endpoint}"`);
  }
  // A service-specific endpoint variable would win over AWS_ENDPOINT_URL for that service.
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("AWS_ENDPOINT_URL_")) fail(`${name} is set; unset it`);
  }
  // Everything other than the emulator's credentials file that the SDK's default
  // chain could use. If that file were missing, the chain would fall through to these.
  for (const name of [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_ROLE_ARN",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  ]) {
    if (process.env[name])
      fail(`${name} is set; unset it so only the emulator's own keys are used`);
  }
  const file = process.env.AWS_SHARED_CREDENTIALS_FILE ?? "";
  if (!existsSync(file)) fail(`AWS_SHARED_CREDENTIALS_FILE "${file}" does not exist`);
  return endpoint.replace(/\/$/, "");
}

function fail(message) {
  console.error(`[spike] ${message}`);
  process.exit(2);
}

/**
 * The [default] key pair from the emulator's generated credentials file, for the
 * readers that take explicit `awsCreds` instead of using the default chain.
 * Read at run time only; the file is deleted when the emulator stops.
 */
export function emulatorCredentials() {
  const text = readFileSync(process.env.AWS_SHARED_CREDENTIALS_FILE, "utf8");
  const section = /\[default\]([^[]*)/.exec(text)?.[1] ?? "";
  const value = (key) => new RegExp(`^\\s*${key}\\s*=\\s*(\\S+)`, "m").exec(section)?.[1];
  const accessKeyId = value("aws_access_key_id");
  const secretAccessKey = value("aws_secret_access_key");
  if (!accessKeyId || !secretAccessKey)
    fail("no [default] key pair in the emulator credentials file");
  const sessionToken = value("aws_session_token");
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

/** The exact error as the caller sees it: class name, message, HTTP status. */
export function describeError(err) {
  const status = err?.$metadata?.httpStatusCode;
  const code = err?.cause?.code ?? err?.code;
  return [
    `${err?.name ?? "Error"}: ${err?.message ?? String(err)}`,
    status ? `HTTP ${status}` : null,
    code ? `cause ${code}` : null,
  ]
    .filter(Boolean)
    .join("; ");
}

/**
 * Collects one row per operation. `check` receives the call's result and returns
 * null when it matches what AWS does, or a string saying how it differs.
 *
 * Outcomes: "ok" (the call succeeded and matched AWS; for a refusal check, the
 * emulator refused as AWS does), "differs" (the call succeeded but its behaviour
 * differs from AWS, including the emulator accepting what AWS refuses), "failed"
 * (the call threw where AWS succeeds, or the driver aborted).
 *
 * `show` turns a successful result into the report's detail column. Results that
 * hold a secret or a presigned URL's signature must pass one that leaves it out.
 */
export class Recorder {
  constructor(area) {
    this.area = area;
    this.rows = [];
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
      detail: difference ?? show(result),
    });
    return result;
  }

  /** Record that the driver stopped early on an error thrown outside op(). */
  aborted(err) {
    this.rows.push({
      area: this.area,
      op: "driver aborted (error outside an operation)",
      outcome: "failed",
      ms: 0,
      detail: describeError(err),
    });
    process.exitCode = 1;
  }

  /** Print the rows as one JSON document on stdout for report.mjs. */
  emit(extra = {}) {
    console.log(JSON.stringify({ area: this.area, rows: this.rows, ...extra }));
  }
}

function ms(started) {
  return Math.round(performance.now() - started);
}

// Byte buffers print as their length, not their contents.
function summarize(result) {
  if (result === undefined) return "";
  const text =
    typeof result === "string"
      ? result
      : JSON.stringify(result, (_, v) =>
          v && v.type === "Buffer" && Array.isArray(v.data) ? `<${v.data.length} bytes>` : v,
        );
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}
