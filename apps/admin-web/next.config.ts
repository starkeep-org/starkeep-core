// Load repo-root .env / .env.local into process.env at Next startup. This is the
// single hook that covers admin-web end-to-end: server route handlers read
// STARKEEP_DIR from process.env, and the daemons / scripts admin-web spawns
// (local-data-server, drive, reset-local-data, cloud installers) inherit it
// because they're spawned without an explicit env. Prefer this single root file
// over Next's per-app .env.local auto-loading so there is one source of truth.
import "@starkeep/app-client/load-env";
import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname, "../.."),
  },
  // Admin-web is operated from the same machine by default, and Next 16
  // blocks cross-origin requests to the dev server. To reach it from another
  // device on your LAN, list that device's view of this host (comma-separated
  // hostnames/IPs, e.g. "192.168.1.51") in STARKEEP_ADMIN_DEV_ORIGINS — the
  // repo-root .env is loaded above, so it can live there.
  ...(process.env.STARKEEP_ADMIN_DEV_ORIGINS
    ? { allowedDevOrigins: process.env.STARKEEP_ADMIN_DEV_ORIGINS.split(",").map((s) => s.trim()) }
    : {}),
  // admin-installer is intentionally NOT transpiled here — admin-web spawns
  // its CLI as a child process (see app/api/cloud-data-server/install). Adding
  // it back would pull @pulumi/* into the dev bundle and OOM the dev server.
  transpilePackages: ["@starkeep/aws-bootstrap", "@starkeep/admin-ui"],
  serverExternalPackages: ["@pulumi/pulumi", "@pulumi/aws", "@pulumi/aws-native"],
};

export default nextConfig;
