/**
 * Captures every AWS SDK v3 call made by the current process to a trace
 * file, with one JSON record per call:
 *
 *   {"t":"2026-05-20T19:14:10.521Z","principal":"arn:aws:sts::123:assumed-role/manager-role/sess",
 *    "clientName":"IAMClient","commandName":"CreateRoleCommand","input":{...}}
 *
 * Mechanism: monkey-patches `Client.prototype.send` in @smithy/smithy-client
 * once at process start. Every @aws-sdk/client-* class inherits from this
 * base, so the patch is global with a single import — no per-client
 * wiring needed.
 *
 * Principal tracking: we maintain an accessKeyId → principalArn map.
 *   - After every AssumeRoleCommand response, store the new session's
 *     accessKeyId → AssumedRoleUser.Arn.
 *   - After every GetCallerIdentityCommand response, store the accessKeyId
 *     it used → its returned Arn (covers the ambient/bootstrap principal).
 *   - At send time, resolve this.config.credentials() to learn which
 *     accessKeyId is making the call and look up the principal.
 *
 * Unknown principals are recorded as "unknown" so the simulator can still
 * see the call but can decide to skip it for context-filtered runs.
 *
 * This is TEMP infrastructure for the iam-permission-tests POC. Remove
 * the patch (and the env-gated activation in admin-installer) when the
 * POC graduates or is dropped.
 *
 * Usage: at the top of an entry-point script, before any AWS SDK client
 * is constructed:
 *
 *   if (process.env.IAM_SDK_TRACE_PATH) {
 *     const { installSdkTrace } = await import(".../sdk-trace");
 *     installSdkTrace(process.env.IAM_SDK_TRACE_PATH);
 *   }
 *
 * The dynamic import keeps @smithy/smithy-client off the import graph
 * when the env var is unset, so production startup is unaffected.
 */

import { createWriteStream, type WriteStream } from "node:fs";
import { Client } from "@smithy/smithy-client";

let installed = false;
let stream: WriteStream | null = null;

/** accessKeyId → principal ARN (assumed-role session ARN, or IAM user ARN). */
const principalsByAccessKey = new Map<string, string>();

interface SmithyClientConfig {
  credentials?: () => Promise<{ accessKeyId: string }>;
}

interface CommandLike {
  constructor: { name: string };
  input?: unknown;
}

async function resolveAccessKeyId(client: { config?: SmithyClientConfig }): Promise<string | undefined> {
  try {
    const provider = client.config?.credentials;
    if (!provider) return undefined;
    const creds = await provider();
    return creds?.accessKeyId;
  } catch {
    return undefined;
  }
}

function captureFromAssumeRoleOutput(output: unknown): void {
  if (!output || typeof output !== "object") return;
  const o = output as {
    Credentials?: { AccessKeyId?: string };
    AssumedRoleUser?: { Arn?: string };
  };
  const ak = o.Credentials?.AccessKeyId;
  const arn = o.AssumedRoleUser?.Arn;
  if (ak && arn) principalsByAccessKey.set(ak, arn);
}

function captureFromGetCallerIdentityOutput(
  output: unknown,
  accessKeyId: string | undefined,
): void {
  if (!accessKeyId || !output || typeof output !== "object") return;
  const arn = (output as { Arn?: string }).Arn;
  if (arn) principalsByAccessKey.set(accessKeyId, arn);
}

export function installSdkTrace(path: string): void {
  if (installed) return;
  installed = true;

  stream = createWriteStream(path, { flags: "w" });

  // Type laundering: `send` is heavily overloaded; we just wrap the
  // dispatch and pass arguments through unmodified.
  const originalSend = Client.prototype.send as unknown as (...args: unknown[]) => Promise<unknown>;

  Client.prototype.send = async function patchedSend(
    this: { constructor: { name: string }; config?: SmithyClientConfig },
    ...args: unknown[]
  ): Promise<unknown> {
    const command = args[0] as CommandLike | undefined;
    const clientName = this?.constructor?.name ?? "UnknownClient";
    const commandName = command?.constructor?.name ?? "UnknownCommand";

    const accessKeyId = await resolveAccessKeyId(this);
    const principal =
      (accessKeyId && principalsByAccessKey.get(accessKeyId)) ?? "unknown";

    record({
      t: new Date().toISOString(),
      principal,
      clientName,
      commandName,
      // Input may contain secrets (PolicyDocument bodies, role names) — we
      // include it because resource ARNs in input are how we'll one day
      // do per-resource sim. Filter at parse time if leakage is a concern.
      input: command?.input,
    });

    const output = await originalSend.apply(this, args as never[]);

    // Learn principals from the call we just made, so subsequent calls
    // can be attributed correctly.
    if (commandName === "AssumeRoleCommand") {
      captureFromAssumeRoleOutput(output);
    } else if (commandName === "GetCallerIdentityCommand") {
      captureFromGetCallerIdentityOutput(output, accessKeyId);
    }

    return output;
  } as typeof Client.prototype.send;
}

function record(entry: object): void {
  if (!stream) return;
  try {
    stream.write(JSON.stringify(entry) + "\n");
  } catch {
    // Trace IO failures must not affect the underlying SDK call.
  }
}
