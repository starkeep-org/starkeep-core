import { createStarkeepSdk } from "@starkeep/sdk";
import type { StarkeepSdk } from "@starkeep/sdk";
import {
  taskPropertiesGenerator,
  taskHistoryGenerator,
  registerTasksEndpoints,
  bootstrapTasksAppPolicies,
  TASKS_APP_ID,
} from "@tasks/tasks-lib";

let _sdk: StarkeepSdk | null = null;

export async function getSdk(): Promise<StarkeepSdk> {
  if (_sdk) return _sdk;

  const ownerId = process.env.OWNER_ID ?? "dev-user";
  const nodeId =
    process.env.NODE_ID ?? `web-${Math.random().toString(36).slice(2)}`;

  let databaseAdapter;
  let objectStorageAdapter;

  if (process.env.AURORA_HOSTNAME) {
    // Cloud: Aurora DSQL + S3
    const { AuroraDsqlDatabaseAdapter } = await import(
      /* webpackIgnore: true */ "@starkeep/storage-aurora-dsql"
    );
    const { S3ObjectStorageAdapter } = await import(
      /* webpackIgnore: true */ "@starkeep/storage-s3"
    );
    const { AuroraDsqlClientFactory } = await import(
      /* webpackIgnore: true */ "./aurora-client-factory"
    );
    databaseAdapter = new AuroraDsqlDatabaseAdapter(
      {
        hostname: process.env.AURORA_HOSTNAME,
        region: process.env.AWS_REGION ?? "us-east-1",
      },
      new AuroraDsqlClientFactory(),
    );
    objectStorageAdapter = new S3ObjectStorageAdapter({
      bucketName: process.env.S3_BUCKET_NAME!,
      region: process.env.AWS_REGION ?? "us-east-1",
    });
  } else {
    // Local dev: SQLite + local filesystem (persistent across restarts)
    const { SqliteDatabaseAdapter } = await import(/* webpackIgnore: true */ "@starkeep/storage-sqlite");
    const { FsObjectStorageAdapter } = await import(/* webpackIgnore: true */ "@starkeep/storage-fs");
    databaseAdapter = new SqliteDatabaseAdapter({
      path: "./.local/tasks.db",
    });
    objectStorageAdapter = new FsObjectStorageAdapter({
      basePath: "./.local/objects",
    });
  }

  const sharedAdapterOptions = { databaseAdapter, objectStorageAdapter, ownerId, nodeId };

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
