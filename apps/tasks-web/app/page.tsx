"use client";

import React from "react";
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
} from "@tasks/tasks-ui";
import type { TdoFileContent } from "@tasks/tasks-lib";
import { SseChatTransport } from "../src/transport/sse-chat-transport";
import { useWebTasks } from "../src/hooks/use-tasks";

function TasksApp() {
  const { settings } = useSettings();
  const { createTask, updateTask } = useWebTasks(settings.userId);

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

  const isMobile =
    typeof window !== "undefined" && window.innerWidth < 768;

  const Layout = isMobile ? MobileSwipeLayout : ThreeColumnLayout;

  return (
    <Layout
      chatPanel={<ChatPanel transport={transport} />}
      taskListPanel={<TaskListPanel onCreateTask={handleCreateTask} />}
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
