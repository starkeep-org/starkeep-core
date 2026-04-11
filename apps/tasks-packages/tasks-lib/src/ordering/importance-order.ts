import type { Task } from "../types/task.js";
import type { TaskOrderingPayload } from "../types/ordering.js";

/**
 * Pure importance ordering:
 * Tasks are sorted by their position in orderedTaskIds.
 * Backlog tasks are always placed after all non-Backlog tasks,
 * maintaining their relative importance order within the Backlog tier.
 */
export function importanceOrder(
  tasks: Task[],
  ordering: TaskOrderingPayload,
): Task[] {
  const indexMap = new Map(
    ordering.orderedTaskIds.map((id, index) => [id, index]),
  );

  const nonBacklog: Task[] = [];
  const backlog: Task[] = [];

  for (const task of tasks) {
    if (task.status === "Backlog") {
      backlog.push(task);
    } else {
      nonBacklog.push(task);
    }
  }

  const byImportance = (a: Task, b: Task) => {
    const ai = indexMap.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bi = indexMap.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return ai - bi;
  };

  nonBacklog.sort(byImportance);
  backlog.sort(byImportance);

  return [...nonBacklog, ...backlog];
}
