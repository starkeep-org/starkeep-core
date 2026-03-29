export interface TaskGroupPayload {
  name: string;
  description: string;
  ownerId: string;
}

export interface TaskGroup {
  id: string;
  payload: TaskGroupPayload;
  createdAt: string;
  updatedAt: string;
}
