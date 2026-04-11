import React, { createContext, useContext, useEffect, useReducer } from "react";
import type { LocalSettings } from "@tasks/tasks-lib";

const STORAGE_KEY = "starkeep:tasks:settings";

const defaultSettings: LocalSettings = {
  userId: "",
  userDisplayName: "Me",
  nodeId: `browser-${Math.random().toString(36).slice(2)}`,
  hostedGroupIds: [],
  collaboratorConnections: [],
  activeGroupId: null,
  activeViewId: "",
  savedViews: [],
  theme: "system",
  lastSyncedAt: null,
  autoSyncIntervalSeconds: 30,
};

function loadSettings(): LocalSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return { ...defaultSettings, ...JSON.parse(raw) } as LocalSettings;
    }
  } catch {
    // ignore parse errors
  }
  return defaultSettings;
}

type SettingsAction = { type: "UPDATE_SETTINGS"; updates: Partial<LocalSettings> };

interface SettingsContextValue {
  settings: LocalSettings;
  dispatch: React.Dispatch<SettingsAction>;
}

function settingsReducer(
  state: LocalSettings,
  action: SettingsAction
): LocalSettings {
  switch (action.type) {
    case "UPDATE_SETTINGS":
      return { ...state, ...action.updates };
    default:
      return state;
  }
}

export const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, dispatch] = useReducer(settingsReducer, undefined, loadSettings);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // ignore write errors
    }
  }, [settings]);

  return (
    <SettingsContext.Provider value={{ settings, dispatch }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error("useSettings must be used within a SettingsProvider");
  }
  return ctx;
}
