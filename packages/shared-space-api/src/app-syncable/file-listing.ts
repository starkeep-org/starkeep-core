import type { AppFileListing } from "../types.js";

/**
 * The wire shape of `GET /app-data/files`, shared by both data servers so the
 * two cannot drift. Snake case, like the rows and `page_token` of the table
 * query beside it.
 */
export function appFileListingJson(listing: AppFileListing): {
  files: {
    sub_key: string;
    size_bytes: number;
    mime_type: string;
    original_filename: string | null;
    created_at: string;
  }[];
  truncated: boolean;
  page_token: string | null;
} {
  return {
    files: listing.files.map((f) => ({
      sub_key: f.subKey,
      size_bytes: f.sizeBytes,
      mime_type: f.mimeType,
      original_filename: f.originalFilename,
      created_at: f.createdAt,
    })),
    truncated: listing.truncated,
    page_token: listing.pageToken,
  };
}
