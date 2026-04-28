import type { ApiRouter } from "@starkeep/shared-space-api";
import { listImagesHandler } from "./handlers/list-images";
import { getImageHandler } from "./handlers/get-image";
import { uploadImageHandler } from "./handlers/upload-image";
import { updateImageHandler } from "./handlers/update-image";
import { deleteImageHandler } from "./handlers/delete-image";
import { getThumbnailHandler } from "./handlers/get-thumbnail";
import { cropImageHandler } from "./handlers/crop-image";
import { listAlbumsHandler } from "./handlers/list-albums";
import { getAlbumHandler } from "./handlers/get-album";
import { createAlbumHandler } from "./handlers/create-album";
import { deleteAlbumHandler } from "./handlers/delete-album";
import { addImageToAlbumHandler } from "./handlers/add-image-to-album";
import { shareImageHandler } from "./handlers/share-image";
import { getSharedImageHandler } from "./handlers/get-shared-image";
import { listGoogleAlbumsHandler } from "./handlers/list-google-albums";
import { listGooglePhotosHandler } from "./handlers/list-google-photos";
import { importGooglePhotoHandler } from "./handlers/import-google-photo";

export function registerPhotosEndpoints(router: ApiRouter): void {
  router.register(listImagesHandler);
  router.register(getImageHandler);
  router.register(uploadImageHandler);
  router.register(updateImageHandler);
  router.register(deleteImageHandler);
  router.register(getThumbnailHandler);
  router.register(cropImageHandler);
  router.register(listAlbumsHandler);
  router.register(getAlbumHandler);
  router.register(createAlbumHandler);
  router.register(deleteAlbumHandler);
  router.register(addImageToAlbumHandler);
  router.register(shareImageHandler);
  router.register(getSharedImageHandler);
  router.register(listGoogleAlbumsHandler);
  router.register(listGooglePhotosHandler);
  router.register(importGooglePhotoHandler);
}
