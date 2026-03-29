import type { TaskStatus } from "./task.js";
import type { OrderingMode } from "./ordering.js";

export interface TaskListViewFilters {
  status?: TaskStatus[];
  assignee?: string; // "{{currentUser}}" is interpolated to the current userId
  labels?: string[];
  excludeStatus?: TaskStatus[];
}

export interface TaskListView {
  viewId: string;
  label: string;
  groupId: string;
  filters: TaskListViewFilters;
  ordering: OrderingMode;
  highlightTaskId?: string;
  limit?: number;
}
