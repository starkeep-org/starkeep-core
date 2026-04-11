import type { ApiRouter } from "@starkeep/shared-space-api";
import { listTasksHandler } from "./handlers/list-tasks.js";
import { getTaskHandler } from "./handlers/get-task.js";
import { createTaskHandler } from "./handlers/create-task.js";
import { updateTaskHandler } from "./handlers/update-task.js";
import { deleteTaskHandler } from "./handlers/delete-task.js";
import { searchTasksHandler } from "./handlers/search-tasks.js";
import { getOrderedTasksHandler } from "./handlers/get-ordered-tasks.js";
import { listGroupsHandler } from "./handlers/list-groups.js";
import { getGroupHandler } from "./handlers/get-group.js";
import { createGroupHandler } from "./handlers/create-group.js";
import { updateGroupHandler } from "./handlers/update-group.js";
import { deleteGroupHandler } from "./handlers/delete-group.js";
import { shareGroupHandler } from "./handlers/share-group.js";
import { setTaskOrderHandler } from "./handlers/set-task-order.js";

export function registerTasksEndpoints(router: ApiRouter): void {
  router.register(listTasksHandler);
  router.register(getTaskHandler);
  router.register(createTaskHandler);
  router.register(updateTaskHandler);
  router.register(deleteTaskHandler);
  router.register(searchTasksHandler);
  router.register(getOrderedTasksHandler);
  router.register(listGroupsHandler);
  router.register(getGroupHandler);
  router.register(createGroupHandler);
  router.register(updateGroupHandler);
  router.register(deleteGroupHandler);
  router.register(shareGroupHandler);
  router.register(setTaskOrderHandler);
}
