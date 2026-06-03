import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname, "../.."),
  },
  // admin-installer is intentionally NOT transpiled here — admin-web spawns
  // its CLI as a child process (see app/api/cloud-data-server/install). Adding
  // it back would pull @pulumi/* into the dev bundle and OOM the dev server.
  transpilePackages: ["@starkeep/aws-bootstrap", "@starkeep/admin-ui"],
  serverExternalPackages: ["@pulumi/pulumi", "@pulumi/aws", "@pulumi/aws-native"],
};

export default nextConfig;
