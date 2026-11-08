import { spawn } from "node:child_process";
import { REPO_ROOT, STREAM_COMMANDS, type StreamCommandId } from "../lib/exec-commands";
import type { STSCredentials } from "../lib/cognito-auth";
import { installerEnv, withoutAwsVariables } from "@starkeep/admin-installer/aws-env";

export async function POST(req: Request) {
  const body = (await req.json()) as {
    id: StreamCommandId;
    credentials?: STSCredentials & { region: string };
  };
  const { id, credentials } = body;

  const cmd = STREAM_COMMANDS[id];
  if (!cmd) {
    return Response.json({ error: "Unknown command ID" }, { status: 400 });
  }
  if (cmd.requiresCreds && !credentials) {
    return Response.json({ error: "Credentials required" }, { status: 400 });
  }

  // Never the shell's AWS variables: a command runs with the wizard's
  // credentials or with none.
  const env = credentials
    ? installerEnv(credentials, credentials.region)
    : withoutAwsVariables(process.env);

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
        controller.enqueue(
          encoder.encode(`event: error\ndata: ${JSON.stringify(err.message)}\n\n`),
        );
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
