/**
 * starkeep-config.json read/write endpoint.
 *
 * The file at REPO_ROOT/starkeep-config.json is the single source of truth for
 * cloud setup. The wizard, install routes, deploy routes, and CLI all read it
 * via this endpoint (or by reading the file directly from server code). No
 * region is stored — region is derived from userPoolId at the point of use.
 *
 * GET   — returns `{ config }` where config is the parsed file or null if
 *         the file does not exist.
 * PATCH — shallow-merges the request body into the file, creating it if
 *         missing. Returns the merged config.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { REPO_ROOT } from "../../../src/lib/exec-commands";

const CONFIG_PATH = resolve(REPO_ROOT, "starkeep-config.json");

function readConfig(): Record<string, unknown> | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function writeConfig(config: Record<string, unknown>): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

export async function GET() {
  return NextResponse.json({ config: readConfig() });
}

export async function PATCH(req: NextRequest) {
  let patch: Record<string, unknown>;
  try {
    patch = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const merged: Record<string, unknown> = { ...(readConfig() ?? {}) };
  // A null value in the patch deletes the field. This is how the wizard
  // invalidates downstream state when the user navigates back a step.
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  // Defensive: ensure no `region` or `s3Region` field is ever persisted.
  // Region is always derived from `userPoolId`.
  delete merged.region;
  delete merged.s3Region;
  writeConfig(merged);
  return NextResponse.json({ config: merged });
}
