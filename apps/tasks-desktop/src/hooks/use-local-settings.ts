import { useSettings } from "@tasks/tasks-ui";
import type { LocalSettings } from "@tasks/tasks-lib";

/** Convenience wrapper over SettingsContext */
export function useLocalSettings(): {
  settings: LocalSettings;
  update: (updates: Partial<LocalSettings>) => void;
} {
  const { settings, dispatch } = useSettings();
  const update = (updates: Partial<LocalSettings>) =>
    dispatch({ type: "UPDATE_SETTINGS", updates });
  return { settings, update };
}
