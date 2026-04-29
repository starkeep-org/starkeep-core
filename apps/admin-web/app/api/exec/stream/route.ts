import { spawn } from "node:child_process";
import { NextRequest, NextResponse } from "next/server";
import { REPO_ROOT, STREAM_COMMANDS, type StreamCommandId } from "../../../../src/lib/exec-commands";
import type { STSCredentials } from "../../../../src/lib/cognito-auth";

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    id: StreamCommandId;
    credentials?: STSCredentials & { region: string };
  };
  const { id, credentials } = body;

  const cmd = STREAM_COMMANDS[id];
  if (!cmd) {
    return NextResponse.json({ error: "Unknown command ID" }, { status: 400 });
  }
  if (cmd.requiresCreds && !credentials) {
    return NextResponse.json({ error: "Credentials required" }, { status: 400 });
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (credentials) {
    env.AWS_ACCESS_KEY_ID = credentials.accessKeyId;
    env.AWS_SECRET_ACCESS_KEY = credentials.secretAccessKey;
    env.AWS_SESSION_TOKEN = credentials.sessionToken;
    env.AWS_REGION = credentials.region;
  }

  const [executable, ...args] = cmd.args;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const child = spawn(executable, args, {
        cwd: REPO_ROOT,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      function emitLines(chunk: Buffer) {
        for (const line of chunk.toString().split("\n")) {
          if (line) controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
        }
      }

      child.stdout.on("data", emitLines);
      child.stderr.on("data", emitLines);

      child.on("close", (code) => {
        controller.enqueue(encoder.encode(`event: done\ndata: ${code ?? 1}\n\n`));
        controller.close();
      });

      child.on("error", (err) => {
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(err.message)}\n\n`));
        controller.close();
      });
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
