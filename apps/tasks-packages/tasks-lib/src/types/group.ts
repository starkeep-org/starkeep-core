export interface TaskGroupPayload {
  name: string;
  description: string;
  ownerId: string;
}

/** Content of the per-group .tdg file in object storage. */
export interface TdgFileContent {
  name: string;
  description: string;
  ownerId: string;
  /** Task IDs in importance order, highest priority first. */
  orderedTaskIds: string[];
}

export interface TaskGroup {
  id: string;
  content: TaskGroupPayload;
  /** Task IDs in importance order, from the .tdg file. */
  orderedTaskIds: string[];
  createdAt: string;
  updatedAt: string;
}
