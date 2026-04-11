export type OrderingMode = "importance" | "comprehensive";

export interface TaskOrderingPayload {
  groupId: string;
  /** Task StarkeepIds, highest priority first */
  orderedTaskIds: string[];
}

/** A task with its computed rank appended */
export interface RankedTask {
  taskId: string;
  comprehensiveRank: number;
}
