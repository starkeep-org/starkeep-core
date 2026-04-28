import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";

export interface GoogleAlbum {
  id: string;
  title: string;
  mediaItemsCount: string;
  coverPhotoBaseUrl: string | null;
}

export const listGoogleAlbumsHandler: ApiEndpointDefinition = {
  namespace: "photos",
  version: "v1",
  path: "photos/google/albums",
  method: "GET",
  handler: async (request: ApiRequest, _context: ApiContext) => {
    const query = request.query ?? {};
    const accessToken = query["accessToken"];
    const pageToken = query["pageToken"];

    if (!accessToken) return { status: 400, body: { error: "accessToken is required" } };

    const params = new URLSearchParams({ pageSize: "50" });
    if (pageToken) params.set("pageToken", pageToken);

    const response = await fetch(
      `https://photoslibrary.googleapis.com/v1/albums?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!response.ok) {
      const text = await response.text();
      return { status: response.status, body: { error: `Google API error: ${text}` } };
    }

    const data = (await response.json()) as {
      albums?: Array<{
        id: string;
        title: string;
        mediaItemsCount?: string;
        coverPhotoBaseUrl?: string;
      }>;
      nextPageToken?: string;
    };

    const albums: GoogleAlbum[] = (data.albums ?? []).map((a) => ({
      id: a.id,
      title: a.title,
      mediaItemsCount: a.mediaItemsCount ?? "0",
      coverPhotoBaseUrl: a.coverPhotoBaseUrl ?? null,
    }));

    return {
      status: 200,
      body: { albums, nextPageToken: data.nextPageToken ?? null },
    };
  },
};
