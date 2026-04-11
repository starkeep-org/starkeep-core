import type { Task } from "../types/task.js";
import type { TaskOrderingPayload } from "../types/ordering.js";

/**
 * Comprehensive ordering — modified Kahn's topological sort:
 *
 * 1. Build a blocker graph from task-type blockers (Done tasks don't count as active blockers)
 * 2. Among ready (unblocked) non-Backlog, non-external-only tasks, sort by importance order
 * 3. Backlog tasks sink after all non-Backlog tasks, maintaining relative importance order
 *    within the Backlog tier (but still subject to blocker constraints)
 * 4. Externally blocked tasks (only external blockers, no task blockers) sink to the very end
 * 5. Cycle detection: break cycles by ignoring the block from the lower-importance task
 */
export function comprehensiveOrder(
  tasks: Task[],
  ordering: TaskOrderingPayload,
): Task[] {
  if (tasks.length === 0) return [];

  const importanceIndex = new Map(
    ordering.orderedTaskIds.map((id, i) => [id, i]),
  );
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  // Build dependency graph: blockedBy[id] = set of task ids that must come first
  // Only task-type blockers where the blocker is not Done
  const blockedBy = new Map<string, Set<string>>();
  const blocks = new Map<string, Set<string>>();

  for (const task of tasks) {
    if (!blockedBy.has(task.id)) blockedBy.set(task.id, new Set());
    if (!blocks.has(task.id)) blocks.set(task.id, new Set());
  }

  for (const task of tasks) {
    for (const blocker of task.blockers) {
      if (blocker.type !== "task") continue;
      const blockerTask = taskMap.get(blocker.taskId);
      if (!blockerTask || blockerTask.status === "Done") continue;
      blockedBy.get(task.id)!.add(blocker.taskId);
      blocks.get(blocker.taskId)!.add(task.id);
    }
  }

  // Cycle detection: break cycles by removing the edge from the lower-importance task
  // (i.e., the task with a higher index in orderedTaskIds)
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function breakCycles(id: string): void {
    if (inStack.has(id)) return;
    if (visited.has(id)) return;
    visited.add(id);
    inStack.add(id);

    for (const dep of [...blockedBy.get(id)!]) {
      if (inStack.has(dep)) {
        // Cycle found: remove the edge from the lower-importance task
        const idRank = importanceIndex.get(id) ?? Number.MAX_SAFE_INTEGER;
        const depRank = importanceIndex.get(dep) ?? Number.MAX_SAFE_INTEGER;
        // The lower-importance (higher rank index) task loses its blocking edge
        if (idRank > depRank) {
          blockedBy.get(id)!.delete(dep);
          blocks.get(dep)!.delete(id);
        } else {
          blockedBy.get(dep)!.delete(id);
          blocks.get(id)!.delete(dep);
        }
      } else {
        breakCycles(dep);
      }
    }

    inStack.delete(id);
  }

  for (const task of tasks) {
    breakCycles(task.id);
  }

  // Kahn's algorithm with importance-based tie-breaking
  const inDegree = new Map(tasks.map((t) => [t.id, blockedBy.get(t.id)!.size]));
  const result: Task[] = [];

  // Categorize for priority in ready queue
  const isExternalOnly = (task: Task) =>
    task.blockers.length > 0 &&
    task.blockers.every((b) => b.type === "external");

  const compareTasks = (a: Task, b: Task) => {
    const aIsBacklog = a.status === "Backlog";
    const bIsBacklog = b.status === "Backlog";
    const aIsExternal = isExternalOnly(a);
    const bIsExternal = isExternalOnly(b);

    // External-only sinks to end
    if (aIsExternal !== bIsExternal) return aIsExternal ? 1 : -1;
    // Backlog sinks after non-backlog (among non-external)
    if (aIsBacklog !== bIsBacklog) return aIsBacklog ? 1 : -1;
    // Within same tier, sort by importance
    const ai = importanceIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bi = importanceIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return ai - bi;
  };

  // Initial ready set
  const ready: Task[] = tasks.filter((t) => inDegree.get(t.id) === 0);
  ready.sort(compareTasks);

  while (ready.length > 0) {
    const task = ready.shift()!;
    result.push(task);

    for (const dependentId of blocks.get(task.id)!) {
      const newDegree = (inDegree.get(dependentId) ?? 0) - 1;
      inDegree.set(dependentId, newDegree);
      if (newDegree === 0) {
        const dependentTask = taskMap.get(dependentId);
        if (dependentTask) {
          // Insert in sorted position
          const insertAt = ready.findIndex(
            (r) => compareTasks(dependentTask, r) < 0,
          );
          if (insertAt === -1) {
            ready.push(dependentTask);
          } else {
            ready.splice(insertAt, 0, dependentTask);
          }
        }
      }
    }
  }

  return result;
}
