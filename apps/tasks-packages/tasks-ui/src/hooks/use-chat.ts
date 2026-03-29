import { useState } from "react";
import type Anthropic from "@anthropic-ai/sdk";
import type { AgentEvent, DisplayMessage, TaskListView } from "@tasks/tasks-lib";

type MessageParam = Anthropic.Messages.MessageParam;
import { useView } from "../context/view-context.js";

export interface ChatTransport {
  send(messages: MessageParam[]): AsyncIterable<AgentEvent>;
}

function toMessageParams(messages: DisplayMessage[]): MessageParam[] {
  return messages
    .filter((m) => m.content.length > 0)
    .map((m) => ({
      role: m.role,
      content: m.content,
    }));
}

export function useChat(transport: ChatTransport) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const { dispatch: dispatchView } = useView();

  const sendMessage = async (text: string) => {
    const userMessage: DisplayMessage = { role: "user", content: text };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setIsLoading(true);

    const assistantMessage: DisplayMessage = { role: "assistant", content: "" };
    setMessages([...nextMessages, assistantMessage]);

    try {
      const params = toMessageParams(nextMessages);
      const stream = transport.send(params);

      for await (const event of stream) {
        if (event.type === "text_delta") {
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.role === "assistant") {
              updated[updated.length - 1] = {
                ...last,
                content: last.content + event.text,
              };
            }
            return updated;
          });
        } else if (
          event.type === "ui_action" &&
          event.toolName === "set_task_list_view"
        ) {
          dispatchView({ type: "SET_VIEW", view: event.args as TaskListView });
        } else if (event.type === "done") {
          setIsLoading(false);
        } else if (event.type === "error") {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: `Error: ${event.message}` },
          ]);
          setIsLoading(false);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${message}` },
      ]);
      setIsLoading(false);
    }
  };

  return { messages, isLoading, sendMessage };
}
