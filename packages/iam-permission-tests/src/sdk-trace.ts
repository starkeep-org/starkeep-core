/**
 * Captures every AWS SDK v3 call made by the current process to a trace
 * file, with one JSON record per call:
 *
 *   {"t":"2026-05-20T19:14:10.521Z","clientName":"IAMClient","commandName":"CreateRoleCommand","input":{...}}
 *
 * Mechanism: monkey-patches `Client.prototype.send` in @smithy/smithy-client
 * once at process start. Every @aws-sdk/client-* class inherits from this
 * base, so the patch is global with a single import — no per-client
 * wiring needed.
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

export function installSdkTrace(path: string): void {
  if (installed) return;
  installed = true;

  stream = createWriteStream(path, { flags: "w" });

  // Type laundering: `send` is heavily overloaded; we just wrap the
  // dispatch and pass arguments through unmodified.
  const originalSend = Client.prototype.send as unknown as (...args: unknown[]) => Promise<unknown>;

  Client.prototype.send = function patchedSend(
    this: { constructor: { name: string } },
    ...args: unknown[]
  ): Promise<unknown> {
    const command = args[0] as { constructor: { name: string }; input?: unknown } | undefined;
    const clientName = this?.constructor?.name ?? "UnknownClient";
    const commandName = command?.constructor?.name ?? "UnknownCommand";
    record({
      t: new Date().toISOString(),
      clientName,
      commandName,
      // Input may contain secrets (PolicyDocument bodies, role names) — we
      // include it because resource ARNs in input are how we'll one day
      // do per-resource sim. Filter at parse time if leakage is a concern.
      input: command?.input,
    });
    return originalSend.apply(this, args as never[]) as Promise<unknown>;
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
