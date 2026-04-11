import Anthropic from "@anthropic-ai/sdk";
import type { StarkeepSdk } from "@starkeep/sdk";
import type { AgentEvent } from "../types/agent.js";
import type { TaskListView } from "../types/view.js";
import { TOOLS, executeTool } from "./tools.js";
import { buildSystemPrompt, type TaskSummary } from "./prompts.js";

export interface AgenticLoopContext {
  sdk: StarkeepSdk;
  userId: string;
  groupId: string;
  apiKey: string;
}

async function fetchTaskSummaries(
  sdk: StarkeepSdk,
  userId: string,
  groupId: string,
): Promise<TaskSummary[]> {
  try {
    const response = await sdk.api.handleRequest({
      path: "tasks:v1/tasks/ordered",
      method: "GET",
      body: undefined,
      query: { groupId, mode: "comprehensive" },
      subject: { subjectType: "user", subjectId: userId },
    });
    const tasks = (response.body as { tasks?: Array<{
      id: string; title: string; status: string; assignee?: string | null;
    }> }).tasks ?? [];
    return tasks
      .filter((t) => t.status !== "Done")
      .map((t) => ({ id: t.id, title: t.title, status: t.status, assignee: t.assignee }));
  } catch {
    return [];
  }
}

export async function* runAgenticLoop(
  messages: Anthropic.MessageParam[],
  context: AgenticLoopContext,
): AsyncGenerator<AgentEvent> {
  const client = new Anthropic({ apiKey: context.apiKey });
  const currentMessages: Anthropic.MessageParam[] = [...messages];

  const tasks = await fetchTaskSummaries(context.sdk, context.userId, context.groupId);

  while (true) {
    const stream = client.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 8096,
      system: buildSystemPrompt(context.userId, context.groupId, tasks),
      messages: currentMessages,
      tools: TOOLS,
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield { type: "text_delta", text: event.delta.text };
      }
    }

    const response = await stream.finalMessage();
    currentMessages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      yield { type: "done" };
      return;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      yield { type: "tool_start", toolName: block.name };

      if (block.name === "set_task_list_view") {
        // UI-control tool: yield as ui_action, executed client-side
        yield {
          type: "ui_action",
          toolName: "set_task_list_view",
          args: block.input as unknown as TaskListView,
        };
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "done",
        });
      } else {
        try {
          const result = await executeTool(
            block.name,
            block.input as Record<string, unknown>,
            { sdk: context.sdk, userId: context.userId, groupId: context.groupId },
          );
          yield { type: "tool_done", toolName: block.name, result };
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          yield { type: "tool_done", toolName: block.name, result: { error: message } };
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify({ error: message }),
            is_error: true,
          });
        }
      }
    }

    currentMessages.push({ role: "user", content: toolResults });
  }
}
