import React, { createContext, useContext } from "react";

interface PhotoUrlContextValue {
  getThumbnailSrc: (imageId: string) => string | null;
  getFullSizeSrc: (imageId: string) => string | null;
}

const PhotoUrlContext = createContext<PhotoUrlContextValue>({
  getThumbnailSrc: (id) => `/api/photos/${id}/thumbnail`,
  getFullSizeSrc: (id) => `/api/photos/${id}/file`,
});

export function PhotoUrlProvider({
  getThumbnailSrc,
  getFullSizeSrc,
  children,
}: {
  getThumbnailSrc?: (imageId: string) => string | null;
  getFullSizeSrc?: (imageId: string) => string | null;
  children: React.ReactNode;
}) {
  const value: PhotoUrlContextValue = {
    getThumbnailSrc: getThumbnailSrc ?? ((id) => `/api/photos/${id}/thumbnail`),
    getFullSizeSrc: getFullSizeSrc ?? ((id) => `/api/photos/${id}/file`),
  };
  return <PhotoUrlContext.Provider value={value}>{children}</PhotoUrlContext.Provider>;
}

export function usePhotoUrls(): PhotoUrlContextValue {
  return useContext(PhotoUrlContext);
}
