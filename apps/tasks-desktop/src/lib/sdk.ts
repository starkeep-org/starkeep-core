import { createStarkeepSdk } from "@starkeep/sdk";
import type { StarkeepSdk } from "@starkeep/sdk";
import {
  taskPropertiesGenerator,
  taskHistoryGenerator,
  registerTasksEndpoints,
} from "@tasks/tasks-lib";
import { TauriDbAdapter } from "./tauri-db-adapter.js";
import { TauriFsObjectStorageAdapter } from "./tauri-fs-adapter.js";

let _sdk: StarkeepSdk | null = null;

export async function getSdk(options: {
  ownerId: string;
  nodeId: string;
}): Promise<StarkeepSdk> {
  if (_sdk) return _sdk;

  _sdk = await createStarkeepSdk({
    databaseAdapter: new TauriDbAdapter(),
    objectStorageAdapter: new TauriFsObjectStorageAdapter(),
    ownerId: options.ownerId,
    nodeId: options.nodeId,
    generators: [taskPropertiesGenerator, taskHistoryGenerator],
  });

  registerTasksEndpoints(_sdk.api.router);

  return _sdk;
}

export function resetSdk(): void {
  _sdk = null;
}
