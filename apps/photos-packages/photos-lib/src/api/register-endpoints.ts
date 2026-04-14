import type { ApiRouter } from "@starkeep/shared-space-api";
import { listImagesHandler } from "./handlers/list-images.js";
import { getImageHandler } from "./handlers/get-image.js";
import { uploadImageHandler } from "./handlers/upload-image.js";
import { updateImageHandler } from "./handlers/update-image.js";
import { deleteImageHandler } from "./handlers/delete-image.js";
import { getThumbnailHandler } from "./handlers/get-thumbnail.js";
import { cropImageHandler } from "./handlers/crop-image.js";
import { listAlbumsHandler } from "./handlers/list-albums.js";
import { getAlbumHandler } from "./handlers/get-album.js";
import { createAlbumHandler } from "./handlers/create-album.js";
import { deleteAlbumHandler } from "./handlers/delete-album.js";
import { addImageToAlbumHandler } from "./handlers/add-image-to-album.js";
import { shareImageHandler } from "./handlers/share-image.js";
import { getSharedImageHandler } from "./handlers/get-shared-image.js";
import { listGoogleAlbumsHandler } from "./handlers/list-google-albums.js";
import { listGooglePhotosHandler } from "./handlers/list-google-photos.js";
import { importGooglePhotoHandler } from "./handlers/import-google-photo.js";

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
