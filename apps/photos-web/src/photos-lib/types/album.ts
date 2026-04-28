/** Content stored in a .pal file in object storage for a media:album record. */
export interface AlbumFileContent {
  name: string;
  description: string;
  coverImageId: string | null;
  orderedImageIds: string[];
}

/** App-layer view combining the DataRecord fields with .pal file content. */
export interface AppAlbum {
  id: string;
  name: string;
  description: string;
  coverImageId: string | null;
  orderedImageIds: string[];
  createdAt: string; // serialized HLC
  updatedAt: string; // serialized HLC
}
