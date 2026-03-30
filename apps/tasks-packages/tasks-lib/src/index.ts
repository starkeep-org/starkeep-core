// Types
export type { TaskStatus, TaskComment, Blocker, TdoFileContent, Task } from "./types/task.js";
export type { TaskGroupPayload, TaskGroup } from "./types/group.js";
export type { OrderingMode, TaskOrderingPayload, RankedTask } from "./types/ordering.js";
export type { TaskListView, TaskListViewFilters } from "./types/view.js";
export type { LocalSettings, CollaboratorConnection } from "./types/settings.js";
export type { AgentEvent, DisplayMessage } from "./types/agent.js";
export type { HistoryEntry } from "./metadata/task-history-generator.js";

// Data helpers
export {
  TASK_RECORD_TYPE,
  TASK_MIME_TYPE,
  createTaskRecord,
  taskRecordToTask,
  encodeTdoFile,
  decodeTdoFile,
} from "./data/task-record.js";
export {
  GROUP_RECORD_TYPE,
  createGroupRecord,
  groupRecordToGroup,
} from "./data/group-record.js";
export {
  ORDERING_RECORD_TYPE,
  createOrderingRecord,
  getOrderingPayload,
  insertTaskInOrdering,
  removeTaskFromOrdering,
} from "./data/ordering-record.js";

// Ordering algorithms
export { importanceOrder } from "./ordering/importance-order.js";
export { comprehensiveOrder } from "./ordering/comprehensive-order.js";

// Metadata generators
export {
  taskPropertiesGenerator,
  TASK_PROPERTIES_GENERATOR_ID,
} from "./metadata/task-properties-generator.js";
export {
  taskHistoryGenerator,
  TASK_HISTORY_GENERATOR_ID,
} from "./metadata/task-history-generator.js";

// API
export { registerTasksEndpoints } from "./api/register-endpoints.js";

// App manifest constants and bootstrap
export { TASKS_APP_ID, TASKS_APP_RECORD_TYPES } from "./manifest.js";
export { bootstrapTasksAppPolicies } from "./bootstrap.js";

// AI
export { runAgenticLoop } from "./ai/agentic-loop.js";
export type { AgenticLoopContext } from "./ai/agentic-loop.js";
export { suggestImportanceIndex } from "./ai/importance-suggest.js";
export { TOOLS, executeTool } from "./ai/tools.js";
export type { ToolContext } from "./ai/tools.js";
export { buildSystemPrompt } from "./ai/prompts.js";
