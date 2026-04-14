import React from "react";
import type { AppImage } from "@photos/photos-lib";
import { usePhotoUrls } from "../../context/photo-url-context.js";

const ORIENTATION_TRANSFORMS: Record<number, string> = {
  3: "rotate(180deg)",
  6: "rotate(90deg)",
  8: "rotate(270deg)",
};

interface PhotoThumbnailProps {
  image: AppImage;
  onSelect: (id: string) => void;
}

export function PhotoThumbnail({ image, onSelect }: PhotoThumbnailProps) {
  const { getThumbnailSrc } = usePhotoUrls();
  const transform = image.exif.orientation
    ? (ORIENTATION_TRANSFORMS[image.exif.orientation] ?? "none")
    : "none";

  return (
    <div
      onClick={() => onSelect(image.id)}
      style={{
        width: 180,
        height: 120,
        overflow: "hidden",
        cursor: "pointer",
        borderRadius: 4,
        background: "#222",
        flexShrink: 0,
      }}
    >
      <img
        src={getThumbnailSrc(image.id)}
        alt={image.title || image.originalFilename}
        loading="lazy"
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform,
          transition: "transform 0.1s ease",
        }}
      />
    </div>
  );
}
