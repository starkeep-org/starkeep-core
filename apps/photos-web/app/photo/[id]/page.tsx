"use client";

import { use } from "react";
import { PhotoViewerPage } from "@photos/photos-ui";

export default function PhotoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <PhotoViewerPage imageId={id} />;
}
