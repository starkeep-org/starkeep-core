import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "../../../../src/lib/exec-commands";

export async function GET() {
  const configPath = resolve(REPO_ROOT, "starkeep-config.json");
  if (!existsSync(configPath)) {
    return NextResponse.json({ error: "starkeep-config.json not found" }, { status: 404 });
  }

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Failed to parse starkeep-config.json" }, { status: 500 });
  }

  const { s3Bucket, s3Region, auroraEndpoint, apiGatewayUrl } = config;
  if (!s3Bucket || !auroraEndpoint) {
    return NextResponse.json(
      { error: "Config is missing s3Bucket or auroraEndpoint — has local:deploy completed successfully?" },
      { status: 404 },
    );
  }

  return NextResponse.json({ s3Bucket, s3Region, auroraEndpoint, apiGatewayUrl });
}
