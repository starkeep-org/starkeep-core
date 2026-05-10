/**
 * Install (or re-install / update) the cloud-data-server built-in app.
 *
 * Triggered by admin-web after the user has signed in with Cognito and the
 * bootstrap CFN stack outputs are loaded into starkeep-config.json. The flow
 * mirrors `packages/admin-installer/scripts/cli-install-cloud-data-server.ts`,
 * but runs server-side inside the local Next.js process and streams progress
 * back to the browser via SSE.
 *
 * Request body:
 *   {
 *     accessKeyId: string,
 *     secretAccessKey: string,
 *     sessionToken: string,
 *   }
 *
 * Response: text/event-stream
 *   Each line emitted via console.log inside installCloudDataServer is
 *   forwarded as `data: <json-encoded line>\n\n`.
 *   Completion: `event: done\ndata: <json outputs>\n\n` then close.
 *   Failure:    `event: error\ndata: <json msg>\n\n` then close.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";
import { installCloudDataServer } from "@starkeep/admin-installer";
import { REPO_ROOT } from "../../../../src/lib/exec-commands";

const CONFIG_PATH = resolve(REPO_ROOT, "starkeep-config.json");

interface StarkeepConfig {
  region: string;
  stage: string;
  accountId?: string;
  userPoolId: string;
  userPoolClientId: string;
  identityPoolId: string;
  permissionsBoundaryArn?: string;
  managerRoleArn?: string;
  pulumiStateBucket?: string;
  apiGatewayUrl?: string;
  apiGatewayId?: string;
  authorizerId?: string;
  s3Bucket?: string;
  s3Region?: string;
  auroraEndpoint?: string;
}

function loadConfig(): StarkeepConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as StarkeepConfig;
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

  const config = loadConfig();
  if (!config) {
    return new Response(
      JSON.stringify({ error: `starkeep-config.json not found at ${CONFIG_PATH}` }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  if (!config.accountId) {
    return new Response(
      JSON.stringify({ error: "starkeep-config.json missing accountId" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const stackPrefix = config.stage;
  const accountId = config.accountId;
  const managerRoleArn =
    config.managerRoleArn ?? `arn:aws:iam::${accountId}:role/${stackPrefix}-manager-role`;
  const permissionsBoundaryArn =
    config.permissionsBoundaryArn
    ?? `arn:aws:iam::${accountId}:policy/${stackPrefix}-app-permissions-boundary`;
  const pulumiStateBucket =
    config.pulumiStateBucket ?? `${stackPrefix}-pulumi-state-${accountId}`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (line: string) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));

      // installCloudDataServer streams progress via console.log. Hijack the
      // global console for the duration of this request to forward those
      // lines as SSE events. This is OK because Next.js API routes run in
      // their own request scope; the patch is reverted in finally.
      const originalLog = console.log;
      const originalWarn = console.warn;
      console.log = (...args: unknown[]) => {
        emit(args.map(String).join(" "));
        originalLog(...args);
      };
      console.warn = (...args: unknown[]) => {
        emit("[warn] " + args.map(String).join(" "));
        originalWarn(...args);
      };

      // Surface the install creds via the env vars consulted by the AWS SDK
      // default credential provider chain. installCloudDataServer's first call
      // is `roleChain([managerRoleArn])` which uses the default chain to
      // assume Manager from these creds.
      const prevAk = process.env.AWS_ACCESS_KEY_ID;
      const prevSk = process.env.AWS_SECRET_ACCESS_KEY;
      const prevSt = process.env.AWS_SESSION_TOKEN;
      const prevRg = process.env.AWS_REGION;
      process.env.AWS_ACCESS_KEY_ID = body.accessKeyId;
      process.env.AWS_SECRET_ACCESS_KEY = body.secretAccessKey;
      process.env.AWS_SESSION_TOKEN = body.sessionToken;
      process.env.AWS_REGION = config.region;

      try {
        const outputs = await installCloudDataServer({
          stackPrefix,
          region: config.region,
          accountId,
          permissionsBoundaryArn,
          managerRoleArn,
          pulumiStateBucket,
          userPoolId: config.userPoolId,
          userPoolClientId: config.userPoolClientId,
        });

        const updated: StarkeepConfig = {
          ...config,
          permissionsBoundaryArn,
          managerRoleArn,
          pulumiStateBucket,
          apiGatewayUrl: outputs.apiGatewayUrl,
          apiGatewayId: outputs.apiGatewayId,
          authorizerId: outputs.authorizerId,
          s3Bucket: outputs.bucketName,
          s3Region: outputs.region,
          auroraEndpoint: outputs.auroraHostname,
        };
        writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2), "utf-8");

        controller.enqueue(
          encoder.encode(`event: done\ndata: ${JSON.stringify(outputs)}\n\n`),
        );
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(msg)}\n\n`));
        controller.close();
      } finally {
        console.log = originalLog;
        console.warn = originalWarn;
        process.env.AWS_ACCESS_KEY_ID = prevAk;
        process.env.AWS_SECRET_ACCESS_KEY = prevSk;
        process.env.AWS_SESSION_TOKEN = prevSt;
        process.env.AWS_REGION = prevRg;
      }
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
