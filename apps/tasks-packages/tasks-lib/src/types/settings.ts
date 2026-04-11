import type { TaskListView } from "./view.js";

export interface CollaboratorConnection {
  groupId: string;
  token: string;
  hostEndpointUrl: string;
  groupName: string;
}

export interface LocalSettings {
  userId: string;
  userDisplayName: string;
  /** HLC node ID, e.g. "browser-{random}" */
  nodeId: string;
  hostedGroupIds: string[];
  collaboratorConnections: CollaboratorConnection[];
  activeGroupId: string | null;
  activeViewId: string;
  savedViews: TaskListView[];
  theme: "light" | "dark" | "system";
  lastSyncedAt: string | null;
  autoSyncIntervalSeconds: number;
}
