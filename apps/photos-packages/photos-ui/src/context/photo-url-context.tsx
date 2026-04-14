import React, { createContext, useContext } from "react";

interface PhotoUrlContextValue {
  getThumbnailSrc: (imageId: string) => string;
}

const PhotoUrlContext = createContext<PhotoUrlContextValue>({
  getThumbnailSrc: (id) => `/api/photos/${id}/thumbnail`,
});

export function PhotoUrlProvider({
  getThumbnailSrc,
  children,
}: {
  getThumbnailSrc?: (imageId: string) => string;
  children: React.ReactNode;
}) {
  const value: PhotoUrlContextValue = {
    getThumbnailSrc: getThumbnailSrc ?? ((id) => `/api/photos/${id}/thumbnail`),
  };
  return <PhotoUrlContext.Provider value={value}>{children}</PhotoUrlContext.Provider>;
}

export function usePhotoUrls(): PhotoUrlContextValue {
  return useContext(PhotoUrlContext);
}
