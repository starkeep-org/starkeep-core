import type { ChatTransport } from "@tasks/tasks-ui";
import type { AgentEvent } from "@tasks/tasks-lib";
import type Anthropic from "@anthropic-ai/sdk";

type MessageParam = Anthropic.Messages.MessageParam;

/**
 * ChatTransport implementation for Next.js.
 * POSTs messages to /api/chat and consumes the SSE response stream.
 */
export class SseChatTransport implements ChatTransport {
  constructor(
    private readonly userId: string,
    private readonly groupId: string,
  ) {}

  async *send(messages: MessageParam[]): AsyncIterable<AgentEvent> {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-User-Id": this.userId,
        "X-Group-Id": this.groupId,
      },
      body: JSON.stringify({ messages }),
    });

    if (!response.ok || !response.body) {
      yield { type: "error", message: `HTTP ${response.status}` };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") return;
        try {
          const event = JSON.parse(data) as AgentEvent;
          yield event;
          if (event.type === "done" || event.type === "error") return;
        } catch {
          // skip malformed lines
        }
      }
    }
  }
}
