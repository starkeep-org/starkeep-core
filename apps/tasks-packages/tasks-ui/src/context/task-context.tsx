import React, { createContext, useContext, useReducer } from "react";
import type { Task } from "@tasks/tasks-lib";

interface TaskState {
  tasks: Task[];
  selectedTaskId: string | null;
}

type TaskAction =
  | { type: "SET_TASKS"; tasks: Task[] }
  | { type: "SELECT_TASK"; id: string | null }
  | { type: "OPTIMISTIC_UPDATE"; task: Task }
  | { type: "OPTIMISTIC_DELETE"; id: string };

interface TaskContextValue extends TaskState {
  selectedTask: Task | null;
  dispatch: React.Dispatch<TaskAction>;
}

function taskReducer(state: TaskState, action: TaskAction): TaskState {
  switch (action.type) {
    case "SET_TASKS":
      return { ...state, tasks: action.tasks };
    case "SELECT_TASK":
      return { ...state, selectedTaskId: action.id };
    case "OPTIMISTIC_UPDATE":
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === action.task.id ? action.task : t
        ),
      };
    case "OPTIMISTIC_DELETE":
      return {
        ...state,
        tasks: state.tasks.filter((t) => t.id !== action.id),
        selectedTaskId:
          state.selectedTaskId === action.id ? null : state.selectedTaskId,
      };
    default:
      return state;
  }
}

const initialState: TaskState = {
  tasks: [],
  selectedTaskId: null,
};

export const TaskContext = createContext<TaskContextValue | null>(null);

export function TaskProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(taskReducer, initialState);

  const selectedTask =
    state.selectedTaskId != null
      ? (state.tasks.find((t) => t.id === state.selectedTaskId) ?? null)
      : null;

  return (
    <TaskContext.Provider value={{ ...state, selectedTask, dispatch }}>
      {children}
    </TaskContext.Provider>
  );
}

export function useTask(): TaskContextValue {
  const ctx = useContext(TaskContext);
  if (!ctx) {
    throw new Error("useTask must be used within a TaskProvider");
  }
  return ctx;
}
