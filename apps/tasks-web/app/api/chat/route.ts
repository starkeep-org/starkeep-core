import { NextRequest, NextResponse } from "next/server";
import { runAgenticLoop } from "@tasks/tasks-lib";
import { getSdk } from "../../_lib/sdk";
import type Anthropic from "@anthropic-ai/sdk";

type MessageParam = Anthropic.Messages.MessageParam;

export async function POST(req: NextRequest): Promise<Response> {
  const userId = req.headers.get("X-User-Id") ?? "anonymous";
  const groupId = req.headers.get("X-Group-Id") ?? "";
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 });
  }

  const body = (await req.json()) as { messages: MessageParam[] };
  const sdk = await getSdk();

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of runAgenticLoop(body.messages, {
          sdk,
          userId,
          groupId,
          apiKey,
        })) {
          const line = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(line));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "error", message })}\n\n`),
        );
      } finally {
        controller.close();
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
