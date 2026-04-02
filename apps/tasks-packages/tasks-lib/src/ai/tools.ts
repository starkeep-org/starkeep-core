import type Anthropic from "@anthropic-ai/sdk";
import type { StarkeepSdk } from "@starkeep/sdk";
import type { ApiRequest } from "@starkeep/shared-space-api";

export interface ToolContext {
  sdk: StarkeepSdk;
  userId: string;
  groupId: string;
}

function makeRequest(
  path: string,
  method: string,
  userId: string,
  body?: unknown,
  query?: Record<string, string>,
): ApiRequest {
  return {
    path,
    method,
    body,
    query,
    subject: { subjectType: "user", subjectId: userId },
  };
}

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "list_tasks",
    description:
      "List tasks in the active group with optional filters. Returns tasks with their IDs. Use mode: \"importance\" before calling set_task_order — the response preserves the exact importance ordering so you can use the returned IDs to construct a new order.",
    input_schema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          enum: ["Blocked", "Backlog", "Todo", "In Progress", "Done"],
          description: "Filter by task status",
        },
        assignee: {
          type: "string",
          description: 'Filter by assignee user ID. Use "{{currentUser}}" for the current user.',
        },
        label: { type: "string", description: "Filter by label" },
        mode: {
          type: "string",
          enum: ["importance", "comprehensive"],
          description: "Ordering mode (default: comprehensive)",
        },
        limit: { type: "number", description: "Max tasks to return (default 50)" },
      },
      required: [],
    },
  },
  {
    name: "get_task",
    description: "Get full details of a single task by ID, including comments and history.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Task ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "create_task",
    description: "Create a new task in the active group.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Task title" },
        description: { type: "string", description: "Task description" },
        status: {
          type: "string",
          enum: ["Backlog", "Todo", "In Progress"],
          description: "Initial status (default: Todo)",
        },
        assignee: { type: "string", description: "User ID to assign the task to" },
        labels: { type: "array", items: { type: "string" }, description: "Labels for the task" },
      },
      required: ["title"],
    },
  },
  {
    name: "update_task",
    description: "Update fields of an existing task. Omit fields you don't want to change.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Task ID to update" },
        title: { type: "string" },
        description: { type: "string" },
        status: {
          type: "string",
          enum: ["Blocked", "Backlog", "Todo", "In Progress", "Done"],
        },
        assignee: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
        comment: { type: "string", description: "Append a new comment to the task" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_task",
    description: "Delete a task permanently. Confirm with the user before calling this.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Task ID to delete" },
      },
      required: ["id"],
    },
  },
  {
    name: "search_tasks",
    description: "Full-text search across task titles and descriptions.",
    input_schema: {
      type: "object" as const,
      properties: {
        q: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
      required: ["q"],
    },
  },
  {
    name: "set_task_order",
    description:
      "Atomically set the importance ordering for all tasks in the active group. " +
      "Call list_tasks with mode: \"importance\" first to get the current task IDs and their order, " +
      "then provide the complete re-ordered array. Every task ID from the group must be included. " +
      "Position 0 = highest priority. One call replaces the entire ordering — never call this multiple times in sequence.",
    input_schema: {
      type: "object" as const,
      properties: {
        orderedTaskIds: {
          type: "array",
          items: { type: "string" },
          description: "Complete ordered list of all task IDs, highest priority first.",
        },
      },
      required: ["orderedTaskIds"],
    },
  },
  {
    name: "analyze_problems",
    description:
      "Analyze the current task list for problems: blocked important tasks, stale In Progress items, and ordering discrepancies.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "set_task_list_view",
    description:
      "Configure the task list panel UI. This is a client-side tool — the UI updates immediately.",
    input_schema: {
      type: "object" as const,
      properties: {
        viewId: { type: "string", description: "Unique view ID" },
        label: { type: "string", description: "Human-readable view name" },
        groupId: { type: "string", description: "Group to show tasks from" },
        filters: {
          type: "object",
          properties: {
            status: {
              type: "array",
              items: {
                type: "string",
                enum: ["Blocked", "Backlog", "Todo", "In Progress", "Done"],
              },
            },
            assignee: { type: "string" },
            labels: { type: "array", items: { type: "string" } },
            excludeStatus: {
              type: "array",
              items: {
                type: "string",
                enum: ["Blocked", "Backlog", "Todo", "In Progress", "Done"],
              },
            },
          },
        },
        ordering: { type: "string", enum: ["importance", "comprehensive"] },
        limit: { type: "number" },
      },
      required: ["viewId", "label", "groupId", "filters", "ordering"],
    },
  },
];

export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<unknown> {
  const { sdk, userId, groupId } = context;

  switch (toolName) {
    case "list_tasks": {
      const query: Record<string, string> = { groupId };
      if (input.status) query.status = String(input.status);
      if (input.assignee) {
        query.assignee =
          input.assignee === "{{currentUser}}" ? userId : String(input.assignee);
      }
      if (input.label) query.label = String(input.label);
      if (input.mode) query.mode = String(input.mode);
      if (input.limit) query.limit = String(input.limit);
      const response = await sdk.api.handleRequest(
        makeRequest("tasks:v1/tasks/ordered", "GET", userId, undefined, { groupId, ...query }),
      );
      return response.body;
    }

    case "get_task": {
      const response = await sdk.api.handleRequest(
        makeRequest("tasks:v1/tasks/item", "GET", userId, undefined, {
          id: String(input.id),
        }),
      );
      return response.body;
    }

    case "create_task": {
      const body = {
        groupId,
        title: String(input.title),
        description: String(input.description ?? ""),
        status: String(input.status ?? "Todo"),
        assignee: input.assignee ? String(input.assignee) : null,
        labels: Array.isArray(input.labels) ? input.labels : [],
        blockers: [],
        comments: [],
      };
      const response = await sdk.api.handleRequest(
        makeRequest("tasks:v1/tasks", "POST", userId, body),
      );
      return response.body;
    }

    case "update_task": {
      const { id, comment, ...rest } = input;
      const updates: Record<string, unknown> = { ...rest };

      // If adding a comment, get existing task first and append
      if (comment) {
        const existing = await sdk.api.handleRequest(
          makeRequest("tasks:v1/tasks/item", "GET", userId, undefined, { id: String(id) }),
        );
        const existingTask = (existing.body as { task?: { comments?: unknown[] } }).task;
        const existingComments = existingTask?.comments ?? [];
        updates.comments = [
          ...existingComments,
          {
            commentId: crypto.randomUUID(),
            author: userId,
            content: String(comment),
            timestamp: new Date().toISOString(),
          },
        ];
      }

      const response = await sdk.api.handleRequest(
        makeRequest("tasks:v1/tasks/item", "PUT", userId, updates, { id: String(id) }),
      );
      return response.body;
    }

    case "delete_task": {
      const response = await sdk.api.handleRequest(
        makeRequest("tasks:v1/tasks/item", "DELETE", userId, undefined, {
          id: String(input.id),
        }),
      );
      return response.body;
    }

    case "search_tasks": {
      const response = await sdk.api.handleRequest(
        makeRequest("tasks:v1/tasks/search", "GET", userId, undefined, {
          q: String(input.q),
          groupId,
          ...(input.limit ? { limit: String(input.limit) } : {}),
        }),
      );
      return response.body;
    }

    case "set_task_order": {
      const response = await sdk.api.handleRequest(
        makeRequest("tasks:v1/tasks/order", "POST", userId, {
          groupId,
          orderedTaskIds: Array.isArray(input.orderedTaskIds) ? input.orderedTaskIds : [],
        }),
      );
      return response.body;
    }

    case "analyze_problems": {
      const response = await sdk.api.handleRequest(
        makeRequest("tasks:v1/tasks/ordered", "GET", userId, undefined, {
          groupId,
          mode: "comprehensive",
        }),
      );
      const tasks = (response.body as { tasks?: Array<{
        id: string; title: string; status: string;
        blockers?: Array<{ type: string }>;
        updatedAt?: string;
      }> }).tasks ?? [];

      const problems: string[] = [];

      const blocked = tasks.filter((t) => t.status === "Blocked");
      if (blocked.length > 0) {
        problems.push(
          `Blocked tasks (${blocked.length}): ${blocked.map((t) => t.title).join(", ")}`,
        );
      }

      const inProgress = tasks.filter((t) => t.status === "In Progress");
      if (inProgress.length > 3) {
        problems.push(
          `Too many In Progress tasks (${inProgress.length}): consider focusing on fewer`,
        );
      }

      if (problems.length === 0) {
        return { analysis: "No major problems found. The task list looks healthy." };
      }

      return { analysis: problems.join("\n\n") };
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
