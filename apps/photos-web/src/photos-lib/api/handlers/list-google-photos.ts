import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";

export interface GoogleMediaItem {
  id: string;
  filename: string;
  mimeType: string;
  baseUrl: string;
  mediaMetadata: {
    creationTime: string;
    width: string;
    height: string;
  };
}

export const listGooglePhotosHandler: ApiEndpointDefinition = {
  namespace: "photos",
  version: "v1",
  path: "photos/google/list",
  method: "GET",
  handler: async (request: ApiRequest, _context: ApiContext) => {
    const query = request.query ?? {};
    const accessToken = query["accessToken"];
    const albumId = query["albumId"];
    const pageToken = query["pageToken"];

    if (!accessToken) return { status: 400, body: { error: "accessToken is required" } };

    let response: Response;

    if (albumId) {
      // Search within a specific album
      const body: Record<string, unknown> = {
        albumId,
        pageSize: 100,
      };
      if (pageToken) body["pageToken"] = pageToken;

      response = await fetch("https://photoslibrary.googleapis.com/v1/mediaItems:search", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } else {
      // List all media items
      const params = new URLSearchParams({ pageSize: "100" });
      if (pageToken) params.set("pageToken", pageToken);

      response = await fetch(
        `https://photoslibrary.googleapis.com/v1/mediaItems?${params}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
    }

    if (!response.ok) {
      const text = await response.text();
      return { status: response.status, body: { error: `Google API error: ${text}` } };
    }

    const data = (await response.json()) as {
      mediaItems?: Array<{
        id: string;
        filename: string;
        mimeType: string;
        baseUrl: string;
        mediaMetadata: {
          creationTime: string;
          width: string;
          height: string;
        };
      }>;
      nextPageToken?: string;
    };

    const mediaItems: GoogleMediaItem[] = (data.mediaItems ?? []).map((item) => ({
      id: item.id,
      filename: item.filename,
      mimeType: item.mimeType,
      baseUrl: item.baseUrl,
      mediaMetadata: {
        creationTime: item.mediaMetadata.creationTime,
        width: item.mediaMetadata.width,
        height: item.mediaMetadata.height,
      },
    }));

    return {
      status: 200,
      body: { mediaItems, nextPageToken: data.nextPageToken ?? null },
    };
  },
};
