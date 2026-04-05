import { useCallback, useEffect } from "react";
import type { Task, TdoFileContent } from "@tasks/tasks-lib";
import { useTask, useView } from "@tasks/tasks-ui";

async function fetchApi<T>(
  path: string,
  method: string,
  userId: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": userId,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    throw new Error(`API ${method} ${path} failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function useWebTasks(userId: string) {
  const { dispatch } = useTask();
  const { activeView } = useView();

  const loadTasks = useCallback(async (groupId: string, ordering = "importance") => {
    const params = new URLSearchParams({ groupId, mode: ordering });
    const result = await fetchApi<{ tasks: Task[] }>(
      `/api/tasks?${params}`,
      "GET",
      userId,
    );
    dispatch({ type: "SET_TASKS", tasks: result.tasks });
  }, [userId, dispatch]);

  useEffect(() => {
    if (!activeView?.groupId) return;
    loadTasks(activeView.groupId, activeView.ordering).catch((err) =>
      console.error("[useWebTasks loadTasks]", err),
    );
  }, [activeView, loadTasks]);

  const createTask = useCallback(
    async (content: TdoFileContent) => {
      const result = await fetchApi<{ task: Task }>(
        "/api/tasks",
        "POST",
        userId,
        content,
      );
      dispatch({ type: "OPTIMISTIC_UPDATE", task: result.task });
      return result.task;
    },
    [userId, dispatch],
  );

  const updateTask = useCallback(
    async (id: string, updates: Partial<TdoFileContent>) => {
      const result = await fetchApi<{ task: Task }>(
        `/api/tasks/${id}`,
        "PUT",
        userId,
        updates,
      );
      dispatch({ type: "OPTIMISTIC_UPDATE", task: result.task });
    },
    [userId, dispatch],
  );

  const deleteTask = useCallback(
    async (id: string) => {
      dispatch({ type: "OPTIMISTIC_DELETE", id });
      await fetchApi(`/api/tasks/${id}`, "DELETE", userId);
    },
    [userId, dispatch],
  );

  return { loadTasks, createTask, updateTask, deleteTask };
}
