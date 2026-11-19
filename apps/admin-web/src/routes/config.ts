/**
 * ~/.starkeep/config.json read/write endpoint.
 *
 * The file at $STARKEEP_DIR/config.json (default: ~/.starkeep/config.json)
 * is the single source of truth for cloud setup. The wizard, install routes,
 * deploy routes, and CLI all read it via this endpoint (or directly from server
 * code). No region is stored — region is derived from userPoolId at the point
 * of use.
 *
 * GET   — returns `{ config }` where config is the parsed file or null if
 *         the file does not exist.
 * PATCH — shallow-merges the request body into the file, creating it if
 *         missing. Returns the merged config.
 */

import { patchConfig, readConfigSeeded } from "@starkeep/operator/config";
import { crossSiteRefusal, fromOwnPage } from "../lib/same-origin";

export async function GET() {
  return Response.json({ config: readConfigSeeded() });
}

export async function PATCH(req: Request) {
  // The file names the cloud this machine joins, which is where its sign-in
  // goes. A web page another site serves must not be able to change it.
  if (!fromOwnPage(req)) return crossSiteRefusal();
  let patch: Record<string, unknown>;
  try {
    patch = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  return Response.json({ config: patchConfig(patch) });
}
