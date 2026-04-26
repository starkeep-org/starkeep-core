import React, { createContext, useContext, useReducer } from "react";
import type { AppImage } from "@photos/photos-lib";

type PhotoAction =
  | { type: "SET_IMAGES"; images: AppImage[] }
  | { type: "APPEND_IMAGES"; images: AppImage[] }
  | { type: "UPSERT_IMAGES"; images: AppImage[] }
  | { type: "OPTIMISTIC_UPDATE"; image: AppImage }
  | { type: "OPTIMISTIC_DELETE"; id: string }
  | { type: "SET_SELECTED_ID"; id: string | null }
  | { type: "SET_NEXT_CURSOR"; cursor: string | null }
  | { type: "SET_LOADING"; loading: boolean };

interface PhotoState {
  images: AppImage[];
  selectedId: string | null;
  nextCursor: string | null;
  loading: boolean;
}

function photoReducer(state: PhotoState, action: PhotoAction): PhotoState {
  switch (action.type) {
    case "SET_IMAGES":
      return { ...state, images: action.images };
    case "APPEND_IMAGES":
      return { ...state, images: [...state.images, ...action.images] };
    case "UPSERT_IMAGES": {
      const incoming = new Map(action.images.map(img => [img.id, img]));
      const merged = state.images.map(img => incoming.get(img.id) ?? img);
      const existingIds = new Set(state.images.map(img => img.id));
      const added = action.images.filter(img => !existingIds.has(img.id));
      return { ...state, images: [...merged, ...added] };
    }
    case "OPTIMISTIC_UPDATE":
      return {
        ...state,
        images: state.images.map((img) =>
          img.id === action.image.id ? action.image : img,
        ),
      };
    case "OPTIMISTIC_DELETE":
      return { ...state, images: state.images.filter((img) => img.id !== action.id) };
    case "SET_SELECTED_ID":
      return { ...state, selectedId: action.id };
    case "SET_NEXT_CURSOR":
      return { ...state, nextCursor: action.cursor };
    case "SET_LOADING":
      return { ...state, loading: action.loading };
    default:
      return state;
  }
}

interface PhotoContextValue {
  state: PhotoState;
  dispatch: React.Dispatch<PhotoAction>;
}

const PhotoContext = createContext<PhotoContextValue | null>(null);

export function PhotoProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(photoReducer, {
    images: [],
    selectedId: null,
    nextCursor: null,
    loading: false,
  });

  return (
    <PhotoContext.Provider value={{ state, dispatch }}>
      {children}
    </PhotoContext.Provider>
  );
}

export function usePhotoContext(): PhotoContextValue {
  const ctx = useContext(PhotoContext);
  if (!ctx) throw new Error("usePhotoContext must be used within a PhotoProvider");
  return ctx;
}
