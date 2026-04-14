import { createStarkeepSdk } from "@starkeep/sdk";
import type { StarkeepSdk, StarkeepId } from "@starkeep/sdk";
import { IMAGE_DIMENSIONS_GENERATOR } from "@starkeep/metadata-core";
import {
  exifGenerator,
  provenanceGenerator,
  userAuthoredGenerator,
  createThumbnailGenerator,
  registerPhotosEndpoints,
  bootstrapPhotosAppPolicies,
  PHOTOS_APP_ID,
  IMAGE_RECORD_TYPE,
} from "@photos/photos-lib";

let _sdk: StarkeepSdk | null = null;

async function createSharpResizeFn() {
  const sharp = (await import(/* webpackIgnore: true */ "sharp")).default;
  return async (imageBytes: Uint8Array, maxWidth: number) => {
    const result = await sharp(imageBytes)
      .resize({ width: maxWidth, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    return {
      data: new Uint8Array(result.data),
      width: result.info.width,
      height: result.info.height,
    };
  };
}

export async function getSdk(): Promise<StarkeepSdk> {
  if (_sdk) return _sdk;

  const ownerId = process.env.OWNER_ID ?? "dev-user";
  const nodeId =
    process.env.NODE_ID ?? `web-${Math.random().toString(36).slice(2)}`;

  let databaseAdapter;
  let objectStorageAdapter;

  if (process.env.AURORA_HOSTNAME) {
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
    const { SqliteDatabaseAdapter } = await import(/* webpackIgnore: true */ "@starkeep/storage-sqlite");
    const { FsObjectStorageAdapter } = await import(/* webpackIgnore: true */ "@starkeep/storage-fs");
    databaseAdapter = new SqliteDatabaseAdapter({ path: "./.local/photos.db" });
    objectStorageAdapter = new FsObjectStorageAdapter({ basePath: "./.local/objects" });
  }

  const sharedAdapterOptions = { databaseAdapter, objectStorageAdapter, ownerId, nodeId };

  const ownerSdk = await createStarkeepSdk({ ...sharedAdapterOptions, generators: [] });
  await bootstrapPhotosAppPolicies(ownerSdk);
  await ownerSdk.close();

  const resizeFn = await createSharpResizeFn();
  const thumbnailGenerator = createThumbnailGenerator(resizeFn);

  _sdk = await createStarkeepSdk({
    ...sharedAdapterOptions,
    generators: [
      IMAGE_DIMENSIONS_GENERATOR,
      exifGenerator,
      provenanceGenerator,
      userAuthoredGenerator,
      thumbnailGenerator,
    ],
    subject: { subjectType: "app", subjectId: PHOTOS_APP_ID },
  });

  registerPhotosEndpoints(_sdk.api.router);
  return _sdk;
}

/**
 * After uploading or importing an image, call this to run all computed
 * generators (dimensions, EXIF, thumbnail) on the new record.
 */
export async function generateImageMetadata(imageId: string): Promise<void> {
  const sdk = await getSdk();
  await sdk.metadata.generateAll(imageId as StarkeepId, IMAGE_RECORD_TYPE);
}
