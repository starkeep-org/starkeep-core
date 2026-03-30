import { TASK_RECORD_TYPE } from "./data/task-record.js";
import { GROUP_RECORD_TYPE } from "./data/group-record.js";
import { ORDERING_RECORD_TYPE } from "./data/ordering-record.js";

/** The canonical app ID for the tasks app. */
export const TASKS_APP_ID = "@tasks/app";

/**
 * All record types that the tasks app reads and writes.
 * An owner-level SDK must grant policies for each of these before the
 * app-scoped SDK is initialised.
 */
export const TASKS_APP_RECORD_TYPES = [
  TASK_RECORD_TYPE,
  GROUP_RECORD_TYPE,
  ORDERING_RECORD_TYPE,
] as const;
