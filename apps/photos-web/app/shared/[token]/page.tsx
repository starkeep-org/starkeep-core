"use client";

import { use } from "react";
import { SharedPhotoPage } from "@photos/photos-ui";

export default function SharedPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  return <SharedPhotoPage token={token} />;
}
