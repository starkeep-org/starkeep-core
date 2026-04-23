import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@photos/photos-lib", "@photos/photos-ui"],
};

export default nextConfig;
