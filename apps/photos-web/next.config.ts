import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  transpilePackages: ["@photos/photos-lib", "@photos/photos-ui"],
};

export default nextConfig;
