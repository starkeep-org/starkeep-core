import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@tasks/tasks-lib", "@tasks/tasks-ui"],
  // Required for workspace packages with ESM + server-only Node.js packages
  serverExternalPackages: [
    "@starkeep/sdk",
    "@starkeep/storage-aurora-dsql",
    "@starkeep/storage-s3",
    "@starkeep/storage-sqlite",
    "@starkeep/storage-fs",
    "pg",
    "@aws-sdk/dsql-signer",
  ],
};

export default nextConfig;
