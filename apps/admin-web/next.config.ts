import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@starkeep/admin-core", "@starkeep/admin-ui"],
};

export default nextConfig;
