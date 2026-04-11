import { createStarkeepSdk } from "@starkeep/sdk";
import type { StarkeepSdk } from "@starkeep/sdk";
import {
  taskPropertiesGenerator,
  taskHistoryGenerator,
  registerTasksEndpoints,
  bootstrapTasksAppPolicies,
  TASKS_APP_ID,
} from "@tasks/tasks-lib";
import { TauriDbAdapter } from "./tauri-db-adapter.js";
import { TauriFsObjectStorageAdapter } from "./tauri-fs-adapter.js";

let _sdk: StarkeepSdk | null = null;

export async function getSdk(options: {
  ownerId: string;
  nodeId: string;
}): Promise<StarkeepSdk> {
  if (_sdk) return _sdk;

  const sharedAdapterOptions = {
    databaseAdapter: new TauriDbAdapter(),
    objectStorageAdapter: new TauriFsObjectStorageAdapter(),
    ownerId: options.ownerId,
    nodeId: options.nodeId,
  };

  // Use an owner-level SDK (no subject) solely to seed access policies on first run.
  const ownerSdk = await createStarkeepSdk({
    ...sharedAdapterOptions,
    generators: [],
  });
  await bootstrapTasksAppPolicies(ownerSdk);
  await ownerSdk.close();

  // Re-initialise as the tasks app subject so all data operations are enforced.
  _sdk = await createStarkeepSdk({
    ...sharedAdapterOptions,
    generators: [taskPropertiesGenerator, taskHistoryGenerator],
    subject: { subjectType: "app", subjectId: TASKS_APP_ID },
  });

  registerTasksEndpoints(_sdk.api.router);

  return _sdk;
}

export function resetSdk(): void {
  _sdk = null;
}
