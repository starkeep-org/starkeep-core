import { useCallback, useEffect, useRef } from "react";
import type { StarkeepSdk } from "@starkeep/sdk";
import type { Task, TdoFileContent } from "@tasks/tasks-lib";
import { useTask } from "@tasks/tasks-ui";
import { useView } from "@tasks/tasks-ui";
import { apiGet, apiPost, apiPut, apiDelete } from "../lib/api.js";

export function useTasks(sdk: StarkeepSdk | null, userId: string) {
  const { dispatch } = useTask();
  const { activeView } = useView();
  const activeViewRef = useRef(activeView);
  activeViewRef.current = activeView;

  const loadTasks = useCallback(async () => {
    if (!sdk || !activeViewRef.current) return;
    const view = activeViewRef.current;
    const query: Record<string, string> = {
      groupId: view.groupId,
      mode: view.ordering,
    };
    if (view.filters.status?.length) {
      query.status = view.filters.status[0]!;
    }
    if (view.filters.assignee) {
      query.assignee =
        view.filters.assignee === "{{currentUser}}"
          ? userId
          : view.filters.assignee;
    }
    if (view.limit) {
      query.limit = String(view.limit);
    }

    const result = await apiGet<{ tasks: Task[] }>(
      sdk,
      "tasks:v1/tasks/ordered",
      userId,
      query,
    );
    dispatch({ type: "SET_TASKS", tasks: result.tasks });
  }, [sdk, userId, dispatch]);

  // Reload when the active view changes
  useEffect(() => {
    loadTasks().catch((err) => console.error("[loadTasks]", err));
  }, [loadTasks, activeView]);

  const createTask = useCallback(
    async (content: TdoFileContent) => {
      if (!sdk) return;
      const result = await apiPost<{ task: Task }>(
        sdk,
        "tasks:v1/tasks",
        userId,
        content,
      );
      dispatch({ type: "OPTIMISTIC_UPDATE", task: result.task });
      await loadTasks();
      return result.task;
    },
    [sdk, userId, dispatch, loadTasks],
  );

  const updateTask = useCallback(
    async (id: string, updates: Partial<TdoFileContent>) => {
      if (!sdk) return;
      const result = await apiPut<{ task: Task }>(
        sdk,
        "tasks:v1/tasks/item",
        userId,
        updates,
        { id },
      );
      dispatch({ type: "OPTIMISTIC_UPDATE", task: result.task });
    },
    [sdk, userId, dispatch],
  );

  const deleteTask = useCallback(
    async (id: string) => {
      if (!sdk) return;
      dispatch({ type: "OPTIMISTIC_DELETE", id });
      await apiDelete(sdk, "tasks:v1/tasks/item", userId, { id });
    },
    [sdk, userId, dispatch],
  );

  return { loadTasks, createTask, updateTask, deleteTask };
}
