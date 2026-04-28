import { useCallback, useEffect } from "react";
import type { AppImage } from "@/photos-lib";
import { usePhotoContext } from "../context/photo-context";

export function usePhotos() {
  const { state, dispatch } = usePhotoContext();

  const fetchPhotos = useCallback(async (cursor?: string) => {
    dispatch({ type: "SET_LOADING", loading: true });
    try {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      const res = await fetch(`/api/photos?${params}`);
      if (!res.ok) return;
      const data = (await res.json()) as { images: AppImage[]; nextCursor: string | null };
      if (cursor) {
        dispatch({ type: "APPEND_IMAGES", images: data.images });
      } else {
        dispatch({ type: "SET_IMAGES", images: data.images });
      }
      dispatch({ type: "SET_NEXT_CURSOR", cursor: data.nextCursor });
    } finally {
      dispatch({ type: "SET_LOADING", loading: false });
    }
  }, [dispatch]);

  useEffect(() => {
    void fetchPhotos();
  }, [fetchPhotos]);

  const loadMore = useCallback(() => {
    if (state.nextCursor) void fetchPhotos(state.nextCursor);
  }, [fetchPhotos, state.nextCursor]);

  const uploadPhoto = useCallback(async (file: File, title?: string, caption?: string): Promise<AppImage | null> => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("originalFilename", file.name);
    if (title) formData.append("title", title);
    if (caption) formData.append("caption", caption ?? "");

    const res = await fetch("/api/photos", { method: "POST", body: formData });
    if (!res.ok) return null;
    const data = (await res.json()) as { image: AppImage };
    dispatch({ type: "APPEND_IMAGES", images: [data.image] });
    return data.image;
  }, [dispatch]);

  const updatePhoto = useCallback(async (
    id: string,
    updates: { caption?: string; title?: string; dateTakenOverride?: string | null },
  ): Promise<AppImage | null> => {
    const res = await fetch(`/api/photos/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { image: AppImage };
    dispatch({ type: "OPTIMISTIC_UPDATE", image: data.image });
    return data.image;
  }, [dispatch]);

  const deletePhoto = useCallback(async (id: string): Promise<boolean> => {
    const res = await fetch(`/api/photos/${id}`, { method: "DELETE" });
    if (!res.ok) return false;
    dispatch({ type: "OPTIMISTIC_DELETE", id });
    return true;
  }, [dispatch]);

  const cropPhoto = useCallback(async (
    sourceImageId: string,
    cropRect: { x: number; y: number; width: number; height: number },
  ): Promise<AppImage | null> => {
    const res = await fetch("/api/photos/crop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceImageId, cropRect }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { image: AppImage };
    dispatch({ type: "APPEND_IMAGES", images: [data.image] });
    return data.image;
  }, [dispatch]);

  const sharePhoto = useCallback(async (imageId: string): Promise<{ token: string; shareUrl: string } | null> => {
    const res = await fetch("/api/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageId }),
    });
    if (!res.ok) return null;
    return (await res.json()) as { token: string; shareUrl: string };
  }, []);

  return {
    images: state.images,
    selectedId: state.selectedId,
    nextCursor: state.nextCursor,
    loading: state.loading,
    fetchPhotos,
    loadMore,
    uploadPhoto,
    updatePhoto,
    deletePhoto,
    cropPhoto,
    sharePhoto,
    selectImage: (id: string | null) => dispatch({ type: "SET_SELECTED_ID", id }),
  };
}
