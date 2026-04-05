import { useState, useCallback, useEffect } from "react";
import type { StarkeepSdk } from "@starkeep/sdk";
import type { TaskGroup } from "@tasks/tasks-lib";
import { apiGet, apiPost } from "../lib/api.js";

export function useGroups(sdk: StarkeepSdk | null, userId: string) {
  const [groups, setGroups] = useState<TaskGroup[]>([]);

  const loadGroups = useCallback(async () => {
    if (!sdk) return;
    const result = await apiGet<{ groups: TaskGroup[] }>(sdk, "tasks:v1/groups", userId);
    setGroups(result.groups);
  }, [sdk, userId]);

  useEffect(() => {
    loadGroups().catch((err) => console.error("[useGroups]", err));
  }, [loadGroups]);

  const createGroup = useCallback(
    async (name: string): Promise<TaskGroup> => {
      if (!sdk) throw new Error("SDK not available");
      const result = await apiPost<{ group: TaskGroup }>(
        sdk,
        "tasks:v1/groups",
        userId,
        { name },
      );
      await loadGroups();
      return result.group;
    },
    [sdk, userId, loadGroups],
  );

  return { groups, loadGroups, createGroup };
}
