import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@photos/photos-lib", "@photos/photos-ui"],
  serverExternalPackages: [
    "@starkeep/sdk",
    "@starkeep/storage-aurora-dsql",
    "@starkeep/storage-s3",
    "@starkeep/storage-sqlite",
    "@starkeep/storage-fs",
    "pg",
    "@aws-sdk/dsql-signer",
    "sharp",
    "exifr",
  ],
};

export default nextConfig;
