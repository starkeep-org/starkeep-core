import { useState, useCallback, useEffect } from "react";
import type { TaskGroup } from "@tasks/tasks-lib";

async function fetchApi<T>(path: string, method: string, userId: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", "X-User-Id": userId },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`API ${method} ${path} failed: ${response.status}`);
  return response.json() as Promise<T>;
}

export function useWebGroups(userId: string) {
  const [groups, setGroups] = useState<TaskGroup[]>([]);

  const loadGroups = useCallback(async () => {
    const result = await fetchApi<{ groups: TaskGroup[] }>("/api/groups", "GET", userId);
    setGroups(result.groups);
  }, [userId]);

  useEffect(() => {
    loadGroups().catch((err) => console.error("[useWebGroups]", err));
  }, [loadGroups]);

  const createGroup = useCallback(
    async (name: string): Promise<TaskGroup> => {
      const result = await fetchApi<{ group: TaskGroup }>("/api/groups", "POST", userId, { name });
      await loadGroups();
      return result.group;
    },
    [userId, loadGroups],
  );

  return { groups, loadGroups, createGroup };
}
