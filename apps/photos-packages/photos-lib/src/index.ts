// Types
export type { AppImage, AppImageExif, CropRect } from "./types/app-image.js";
export type { AlbumFileContent, AppAlbum } from "./types/album.js";

// Data helpers
export { IMAGE_RECORD_TYPE, createImageRecord } from "./data/image-record.js";
export {
  ALBUM_RECORD_TYPE,
  ALBUM_MIME_TYPE,
  albumObjectStorageKey,
  createAlbumRecord,
  albumRecordToAppAlbum,
  loadPalFile,
  writePalFile,
  encodePalFile,
  decodePalFile,
} from "./data/album-record.js";

// Metadata generators
export { exifGenerator, EXIF_GENERATOR_ID } from "./metadata/exif-generator.js";
export { provenanceGenerator, PROVENANCE_GENERATOR_ID } from "./metadata/provenance-generator.js";
export {
  userAuthoredGenerator,
  USER_AUTHORED_GENERATOR_ID,
} from "./metadata/user-authored-generator.js";
export {
  createThumbnailGenerator,
  THUMBNAIL_GENERATOR_ID,
  THUMBNAIL_MAX_WIDTH,
} from "./metadata/thumbnail-generator.js";
export type { ResizeFunction, ResizeResult } from "./metadata/thumbnail-generator.js";

// API
export { registerPhotosEndpoints } from "./api/register-endpoints.js";

// Assembly helpers (for use in route handlers that need to build AppImage outside the SDK)
export { assembleAppImage, assembleAppImages } from "./api/helpers/assemble-app-image.js";

// App manifest constants and bootstrap
export { PHOTOS_APP_ID, PHOTOS_APP_RECORD_TYPES } from "./manifest.js";
export { bootstrapPhotosAppPolicies } from "./bootstrap.js";

// Google Photos types (for use in UI)
export type { GoogleAlbum } from "./api/handlers/list-google-albums.js";
export type { GoogleMediaItem } from "./api/handlers/list-google-photos.js";
