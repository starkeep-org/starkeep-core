import type { GeneratingFunctionDefinition, GeneratingFunctionInput, GenerationContext } from "@starkeep/metadata-engine";
import { TASK_RECORD_TYPE, decodeTdoFile } from "../data/task-record.js";
import type { TdoFileContent } from "../types/task.js";

export const TASK_PROPERTIES_GENERATOR_ID = "tasks:properties";

export interface TaskPropertiesValue {
  groupId: string;
  assignee: string | null;
  status: string;
  labels: string[];
  taskBlockerIds: string[];
  hasExternalBlockers: boolean;
  commentCount: number;
}

export const taskPropertiesGenerator: GeneratingFunctionDefinition = {
  generatorId: TASK_PROPERTIES_GENERATOR_ID,
  generatorVersion: 1,
  inputTypes: [TASK_RECORD_TYPE],
  dependsOn: [],
  outputColumns: [
    { name: "group_id", columnType: "text" },
    { name: "assignee", columnType: "text" },
    { name: "status", columnType: "text" },
    { name: "labels", columnType: "text" },
    { name: "task_blocker_ids", columnType: "text" },
    { name: "has_external_blockers", columnType: "boolean" },
    { name: "comment_count", columnType: "integer" },
  ],

  async generate(
    input: GeneratingFunctionInput,
    context: GenerationContext,
  ) {
    const record = await context.databaseAdapter.get(input.dataRecordId);
    if (!record || !record.objectStorageKey) {
      throw new Error(`Task record not found or has no file: ${input.dataRecordId}`);
    }

    const result = await context.objectStorageAdapter.get(record.objectStorageKey);
    if (!result) {
      throw new Error(`Task file not found in object storage: ${record.objectStorageKey}`);
    }

    const content: TdoFileContent = decodeTdoFile(result.data);

    const value: TaskPropertiesValue = {
      groupId: content.groupId,
      assignee: content.assignee,
      status: content.status,
      labels: content.labels,
      taskBlockerIds: content.blockers
        .filter((b) => b.type === "task")
        .map((b) => (b as { type: "task"; taskId: string }).taskId),
      hasExternalBlockers: content.blockers.some((b) => b.type === "external"),
      commentCount: content.comments.length,
    };

    return { value: value as unknown as Record<string, unknown> };
  },
};
