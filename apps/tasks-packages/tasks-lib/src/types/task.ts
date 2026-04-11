export type TaskStatus =
  | "Blocked"
  | "Backlog"
  | "Todo"
  | "In Progress"
  | "Done";

export interface TaskComment {
  commentId: string;
  author: string;
  content: string;
  timestamp: string; // ISO 8601
}

export type Blocker =
  | { type: "task"; taskId: string }
  | { type: "external"; description: string };

/** Stored as JSON in object storage (.tdo file). Source of truth for task content. */
export interface TdoFileContent {
  groupId: string;
  title: string;
  description: string;
  assignee: string | null;
  status: TaskStatus;
  blockers: Blocker[];
  labels: string[];
  comments: TaskComment[];
}

/** Full task as returned by the API — combines DataRecord metadata with TdoFileContent */
export interface Task extends TdoFileContent {
  id: string;
  createdAt: string;
  updatedAt: string;
  objectStorageKey: string;
}
