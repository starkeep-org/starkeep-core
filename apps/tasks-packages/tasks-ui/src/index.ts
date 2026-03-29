// Contexts
export { TaskContext, TaskProvider, useTask } from "./context/task-context.js";
export { ViewContext, ViewProvider, useView } from "./context/view-context.js";
export {
  SettingsContext,
  SettingsProvider,
  useSettings,
} from "./context/settings-context.js";

// Hooks
export { useChat } from "./hooks/use-chat.js";
export type { ChatTransport } from "./hooks/use-chat.js";

// Layout components
export { ThreeColumnLayout } from "./components/layout/three-column-layout.js";
export { MobileSwipeLayout } from "./components/layout/mobile-swipe-layout.js";

// Chat components
export { ChatPanel } from "./components/chat/chat-panel.js";
export { MessageItem } from "./components/chat/message-item.js";

// Task list components
export { TaskCard } from "./components/task-list/task-card.js";
export { ViewPicker } from "./components/task-list/view-picker.js";
export { TaskListPanel } from "./components/task-list/task-list-panel.js";

// Task detail components
export { CommentThread } from "./components/task-detail/comment-thread.js";
export { HistoryLog } from "./components/task-detail/history-log.js";
export { TaskForm } from "./components/task-detail/task-form.js";
export { TaskDetailPanel } from "./components/task-detail/task-detail-panel.js";
