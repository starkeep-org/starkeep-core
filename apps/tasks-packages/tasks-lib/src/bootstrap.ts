import type { StarkeepSdk } from "@starkeep/sdk";
import { TASKS_APP_ID, TASKS_APP_RECORD_TYPES } from "./manifest.js";
import { TASK_RECORD_TYPE } from "./data/task-record.js";

const TYPE_REGISTRATION_RECORD_TYPE = "@starkeep/type-registration";

/**
 * JSON Schema for a `todo:task` DataRecord's payload field.
 * The full task content (title, description, etc.) lives in object storage
 * as a .tdo file; the payload carries only the indexed cross-reference.
 */
const TODO_TASK_SCHEMA = {
  type: "object",
  properties: {
    groupId: { type: "string", description: "ID of the group this task belongs to" },
  },
  required: ["groupId"],
  additionalProperties: false,
};

/**
 * Idempotent bootstrap for the tasks app.
 * Must be called with an **owner-level** SDK (no `subject`) before initialising
 * the app-scoped SDK. Performs two things:
 *
 * 1. Registers the `todo:task` type in the global type registry if not already present.
 * 2. Grants the tasks app type-level read/write/delete policies for each of its record types.
 */
export async function bootstrapTasksAppPolicies(ownerSdk: StarkeepSdk): Promise<void> {
  // --- 1. Type registration ---
  const existingRegistrations = await ownerSdk.data.query({
    type: TYPE_REGISTRATION_RECORD_TYPE,
    filters: [{ field: "payload.typeId", operator: "eq", value: TASK_RECORD_TYPE }],
  });

  if (existingRegistrations.length === 0) {
    await ownerSdk.data.put({
      type: TYPE_REGISTRATION_RECORD_TYPE,
      ownerId: "owner",
      payload: {
        typeId: TASK_RECORD_TYPE,
        schema: TODO_TASK_SCHEMA,
        schemaVersion: "1.0.0",
        description: "A task stored in the shared space. Full content is in object storage (.tdo file); payload carries the groupId index field.",
        registeredByAppId: TASKS_APP_ID,
      },
    });
  }

  // --- 2. Access policies ---
  const existing = await ownerSdk.accessControl.listPolicies({ subjectId: TASKS_APP_ID });
  const coveredTypes = new Set(
    existing
      .filter((p) => p.resourceType === "type")
      .map((p) => p.resourceId),
  );

  for (const recordType of TASKS_APP_RECORD_TYPES) {
    if (coveredTypes.has(recordType)) continue;

    await ownerSdk.accessControl.createPolicy({
      subjectType: "app",
      subjectId: TASKS_APP_ID,
      resourceType: "type",
      resourceId: recordType,
      permissions: ["read", "write", "delete"],
    });
  }
}
