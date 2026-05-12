/**
 * Install (or re-install / update) the cloud-data-server built-in app.
 *
 * Spawns `packages/admin-installer/scripts/cli-install-cloud-data-server.ts`
 * as a child process and streams its stdout/stderr to the browser via SSE.
 * Running Pulumi out-of-process keeps `@pulumi/*` (and the rest of the
 * installer source tree) out of admin-web's dev bundle — the dev server was
 * OOMing because the bundler kept those module graphs hot.
 *
 * Request body: { accessKeyId, secretAccessKey, sessionToken }
 *
 * Response: text/event-stream
 *   data:  <stdout/stderr line>
 *   event: done   data: { apiGatewayUrl, apiGatewayId, authorizerId,
 *                         bucketName, region, auroraHostname }
 *   event: error  data: <message>
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";
import { REPO_ROOT } from "../../../../src/lib/exec-commands";

const CONFIG_PATH = resolve(REPO_ROOT, "starkeep-config.json");

interface StarkeepConfig {
  region: string;
  apiGatewayUrl?: string;
  apiGatewayId?: string;
  authorizerId?: string;
  s3Bucket?: string;
  s3Region?: string;
  auroraEndpoint?: string;
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
  };

  if (!body.accessKeyId || !body.secretAccessKey || !body.sessionToken) {
    return new Response(
      JSON.stringify({ error: "accessKeyId, secretAccessKey, sessionToken required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!existsSync(CONFIG_PATH)) {
    return new Response(
      JSON.stringify({ error: `starkeep-config.json not found at ${CONFIG_PATH}` }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const preConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as StarkeepConfig;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const emit = (line: string) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));

      const child = spawn(
        "pnpm",
        [
          "--filter",
          "@starkeep/admin-installer",
          "cli:install-cloud-data-server",
          "--non-interactive",
        ],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            AWS_ACCESS_KEY_ID: body.accessKeyId,
            AWS_SECRET_ACCESS_KEY: body.secretAccessKey,
            AWS_SESSION_TOKEN: body.sessionToken,
            AWS_REGION: preConfig.region,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let buffer = "";
      const onChunk = (chunk: Buffer) => {
        buffer += chunk.toString();
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.length > 0) emit(line);
        }
      };
      child.stdout.on("data", onChunk);
      child.stderr.on("data", onChunk);

      child.on("error", (err) => {
        controller.enqueue(
          encoder.encode(`event: error\ndata: ${JSON.stringify(err.message)}\n\n`),
        );
        controller.close();
      });

      child.on("close", (code) => {
        if (buffer.length > 0) emit(buffer);
        if (code === 0) {
          try {
            const post = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as StarkeepConfig;
            const outputs = {
              apiGatewayUrl: post.apiGatewayUrl,
              apiGatewayId: post.apiGatewayId,
              authorizerId: post.authorizerId,
              bucketName: post.s3Bucket,
              region: post.s3Region,
              auroraHostname: post.auroraEndpoint,
            };
            controller.enqueue(
              encoder.encode(`event: done\ndata: ${JSON.stringify(outputs)}\n\n`),
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            controller.enqueue(
              encoder.encode(
                `event: error\ndata: ${JSON.stringify(`Install completed but reading outputs failed: ${msg}`)}\n\n`,
              ),
            );
          }
        } else {
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify(`Installer exited with code ${code}`)}\n\n`,
            ),
          );
        }
        controller.close();
      });
    },
    cancel() {
      // Client disconnected — best-effort: the child is in its own process
      // group via pnpm, so we'd need to track and SIGTERM it. For now leave
      // it running so an aborted browser tab doesn't kill a Pulumi up mid-
      // way through provisioning AWS resources.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
