import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ChatTransport } from "@tasks/tasks-ui";
import type { AgentEvent, DisplayMessage } from "@tasks/tasks-lib";
import type Anthropic from "@anthropic-ai/sdk";

type MessageParam = Anthropic.Messages.MessageParam;

/**
 * ChatTransport implementation for Tauri.
 * Sends messages to the Rust sidecar via invoke() and receives
 * AgentEvent stream via Tauri event listener.
 */
export class IpcChatTransport implements ChatTransport {
  constructor(
    private readonly userId: string,
    private readonly groupId: string,
  ) {}

  async *send(messages: MessageParam[]): AsyncIterable<AgentEvent> {
    // Start the agentic loop in the Rust sidecar
    const sessionId = crypto.randomUUID();

    // Set up event listener before invoking to avoid race
    const events: AgentEvent[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    const unlisten = await listen<AgentEvent>(
      `agent_event:${sessionId}`,
      (event) => {
        events.push(event.payload);
        resolve?.();
        resolve = null;
      },
    );

    // Invoke the Rust command to start the agentic loop
    void invoke("run_chat", {
      sessionId,
      messages: JSON.stringify(messages),
      userId: this.userId,
      groupId: this.groupId,
    }).catch((err: unknown) => {
      events.push({ type: "error", message: String(err) });
      done = true;
      resolve?.();
      resolve = null;
    });

    try {
      while (true) {
        // Drain buffered events
        while (events.length > 0) {
          const event = events.shift()!;
          yield event;
          if (event.type === "done" || event.type === "error") {
            return;
          }
        }

        if (done) return;

        // Wait for next event
        await new Promise<void>((res) => {
          if (events.length > 0) {
            res();
          } else {
            resolve = res;
          }
        });
      }
    } finally {
      unlisten();
    }
  }
}

/** Convert DisplayMessage[] to Anthropic MessageParam[] */
export function toMessageParams(messages: DisplayMessage[]): MessageParam[] {
  return messages
    .filter((m) => m.content.length > 0)
    .map((m) => ({ role: m.role, content: m.content }));
}
