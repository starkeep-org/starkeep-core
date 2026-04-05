"use client";

import React, { useEffect } from "react";
import {
  TaskProvider,
  ViewProvider,
  SettingsProvider,
  ThreeColumnLayout,
  MobileSwipeLayout,
  ChatPanel,
  TaskListPanel,
  TaskDetailPanel,
  useSettings,
  useView,
} from "@tasks/tasks-ui";
import type { TdoFileContent } from "@tasks/tasks-lib";
import { SseChatTransport } from "../src/transport/sse-chat-transport";
import { useWebTasks } from "../src/hooks/use-tasks";
import { useWebGroups } from "../src/hooks/use-groups";

function TasksApp() {
  const { settings, dispatch: dispatchSettings } = useSettings();
  const { dispatch: dispatchView } = useView();
  const { createTask, updateTask } = useWebTasks(settings.userId);
  const { groups, createGroup } = useWebGroups(settings.userId);

  // Initialize active group: on first load (or when groups arrive), ensure
  // settings.activeGroupId is set and the view context reflects it.
  useEffect(() => {
    if (groups.length === 0) return;
    const id = settings.activeGroupId && groups.some((g) => g.id === settings.activeGroupId)
      ? settings.activeGroupId
      : groups[0]!.id;
    if (id !== settings.activeGroupId) {
      dispatchSettings({ type: "UPDATE_SETTINGS", updates: { activeGroupId: id } });
    }
    dispatchView({
      type: "SET_VIEW",
      view: {
        viewId: "all-tasks",
        label: "All Tasks",
        groupId: id,
        filters: {},
        ordering: "importance",
      },
    });
  }, [groups]);

  const transport = new SseChatTransport(
    settings.userId,
    settings.activeGroupId ?? "",
  );

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

  const handleUpdate = async (id: string, updates: Partial<TdoFileContent>) => {
    await updateTask(id, updates);
  };

  const handleSelectGroup = (groupId: string) => {
    dispatchSettings({ type: "UPDATE_SETTINGS", updates: { activeGroupId: groupId } });
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

  const isMobile =
    typeof window !== "undefined" && window.innerWidth < 768;

  const Layout = isMobile ? MobileSwipeLayout : ThreeColumnLayout;

  return (
    <Layout
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
        <TaskDetailPanel onUpdate={handleUpdate} historyEntries={[]} />
      }
    />
  );
}

export default function Home() {
  return (
    <SettingsProvider>
      <TaskProvider>
        <ViewProvider>
          <TasksApp />
        </ViewProvider>
      </TaskProvider>
    </SettingsProvider>
  );
}
