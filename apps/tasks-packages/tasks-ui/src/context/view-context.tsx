import React, { createContext, useContext, useReducer } from "react";
import type { TaskListView } from "@tasks/tasks-lib";

interface ViewState {
  activeView: TaskListView | null;
  savedViews: TaskListView[];
}

type ViewAction =
  | { type: "SET_VIEW"; view: TaskListView }
  | { type: "SAVE_VIEW"; view: TaskListView }
  | { type: "DELETE_VIEW"; viewId: string };

interface ViewContextValue extends ViewState {
  dispatch: React.Dispatch<ViewAction>;
}

function viewReducer(state: ViewState, action: ViewAction): ViewState {
  switch (action.type) {
    case "SET_VIEW":
      return { ...state, activeView: action.view };
    case "SAVE_VIEW": {
      const exists = state.savedViews.some(
        (v) => v.viewId === action.view.viewId
      );
      return {
        ...state,
        savedViews: exists
          ? state.savedViews.map((v) =>
              v.viewId === action.view.viewId ? action.view : v
            )
          : [...state.savedViews, action.view],
      };
    }
    case "DELETE_VIEW":
      return {
        ...state,
        savedViews: state.savedViews.filter((v) => v.viewId !== action.viewId),
        activeView:
          state.activeView?.viewId === action.viewId
            ? null
            : state.activeView,
      };
    default:
      return state;
  }
}

const initialState: ViewState = {
  activeView: null,
  savedViews: [],
};

export const ViewContext = createContext<ViewContextValue | null>(null);

export function ViewProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(viewReducer, initialState);

  return (
    <ViewContext.Provider value={{ ...state, dispatch }}>
      {children}
    </ViewContext.Provider>
  );
}

export function useView(): ViewContextValue {
  const ctx = useContext(ViewContext);
  if (!ctx) {
    throw new Error("useView must be used within a ViewProvider");
  }
  return ctx;
}
