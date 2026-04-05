import React, { useEffect, useState } from "react";
import {
  TaskProvider,
  ViewProvider,
  SettingsProvider,
  ThreeColumnLayout,
  ChatPanel,
  TaskListPanel,
  TaskDetailPanel,
  useSettings,
  useView,
} from "@tasks/tasks-ui";
import type { StarkeepSdk } from "@starkeep/sdk";
import type { TdoFileContent } from "@tasks/tasks-lib";
import { IpcChatTransport } from "./transport/ipc-chat-transport.js";
import { useLocalSettings } from "./hooks/use-local-settings.js";
import { useTasks } from "./hooks/use-tasks.js";
import { useGroups } from "./hooks/use-groups.js";
import { apiGet, apiPost } from "./lib/api.js";
import { getSdk } from "./lib/sdk.js";
import type { HistoryEntry, TaskGroup } from "@tasks/tasks-lib";

function AppInner({ sdk }: { sdk: StarkeepSdk }) {
  const { settings, update: updateSettings } = useLocalSettings();
  const { dispatch: dispatchView } = useView();
  const { createTask, updateTask } = useTasks(sdk, settings.userId);
  const { groups, createGroup } = useGroups(sdk, settings.userId);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const transport = new IpcChatTransport(settings.userId, settings.activeGroupId ?? "");

  const handleTaskSelect = async (taskId: string) => {
    try {
      const result = await apiGet<{ entries: HistoryEntry[] }>(
        sdk,
        "tasks:v1/tasks/history",
        settings.userId,
        { id: taskId },
      );
      setHistoryEntries(result.entries ?? []);
    } catch {
      setHistoryEntries([]);
    }
  };

  const handleUpdate = async (id: string, updates: Partial<TdoFileContent>) => {
    await updateTask(id, updates);
  };

  const handleCreateTask = async (title: string) => {
    if (!settings.activeGroupId) return;
    await createTask({
      groupId: settings.activeGroupId,
      title,
      description: "",
      assignee: null,
      status: "Todo",
      blockers: [],
      labels: [],
      comments: [],
    });
  };

  const handleSelectGroup = (groupId: string) => {
    updateSettings({ activeGroupId: groupId });
    dispatchView({
      type: "SET_VIEW",
      view: {
        viewId: "all-tasks",
        label: "All Tasks",
        groupId,
        filters: {},
        ordering: "importance",
      },
    });
  };

  const handleCreateGroup = async (name: string) => {
    const group = await createGroup(name);
    handleSelectGroup(group.id);
  };

  return (
    <ThreeColumnLayout
      chatPanel={<ChatPanel transport={transport} />}
      taskListPanel={
        <TaskListPanel
          onCreateTask={handleCreateTask}
          groups={groups}
          activeGroupId={settings.activeGroupId}
          onSelectGroup={handleSelectGroup}
          onCreateGroup={handleCreateGroup}
        />
      }
      taskDetailPanel={
        <TaskDetailPanel
          onUpdate={handleUpdate}
          historyEntries={historyEntries}
        />
      }
    />
  );
}

function SdkLoader() {
  const { settings, dispatch: dispatchSettings } = useSettings();
  const { dispatch: dispatchView } = useView();
  const [sdk, setSdk] = useState<StarkeepSdk | null>(null);

  useEffect(() => {
    const ownerId = settings.userId || "local-user";
    const nodeId = settings.nodeId;
    getSdk({ ownerId, nodeId }).then(async (s) => {
      let activeGroupId = settings.activeGroupId;

      // Verify the stored group still exists — the DB may have been reset while
      // localStorage kept the old ID, which causes set_task_order to 404.
      if (activeGroupId) {
        try {
          await apiGet<{ group: TaskGroup }>(s, "tasks:v1/groups/item", ownerId, { id: activeGroupId });
        } catch {
          activeGroupId = null;
        }
      }

      if (!activeGroupId) {
        const result = await apiPost<{ group: TaskGroup }>(
          s, "tasks:v1/groups", ownerId, { name: "Personal" },
        );
        activeGroupId = result.group.id;
        dispatchSettings({ type: "UPDATE_SETTINGS", updates: { activeGroupId, userId: ownerId } });
      }
      dispatchView({
        type: "SET_VIEW",
        view: {
          viewId: "all-tasks",
          label: "All Tasks",
          groupId: activeGroupId,
          filters: {},
          ordering: "importance",
        },
      });
      setSdk(s);
    });
  }, []);

  if (!sdk) return null;
  return <AppInner sdk={sdk} />;
}

export function App() {
  return (
    <SettingsProvider>
      <TaskProvider>
        <ViewProvider>
          <SdkLoader />
        </ViewProvider>
      </TaskProvider>
    </SettingsProvider>
  );
}
