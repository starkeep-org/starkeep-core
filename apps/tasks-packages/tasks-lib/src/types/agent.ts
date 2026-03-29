import type { TaskListView } from "./view.js";

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; toolName: string }
  | { type: "tool_done"; toolName: string; result: unknown }
  | { type: "ui_action"; toolName: "set_task_list_view"; args: TaskListView }
  | { type: "done" }
  | { type: "error"; message: string };

export interface DisplayMessage {
  role: "user" | "assistant";
  content: string;
}
