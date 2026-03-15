import type { ChangeNotifier, ChangeListener, ChangeEvent } from "./types.js";

export function createChangeNotifier(): ChangeNotifier {
  const listeners = new Set<ChangeListener>();

  return {
    subscribe(listener: ChangeListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    emit(event: ChangeEvent): void {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}
