/**
 * GET /api/apps/list marks core's example app, found through the folder a new
 * config seeds, so its card can offer Hide. A copy of the app elsewhere is an
 * author's app and gets no mark.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { cpSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_APPS_DIR } from "@starkeep/admin-installer/app-discovery";
import { makeDataDir, writeAdminConfig } from "../helpers";

type ListedApp = { appId: string; sourceDir: string; bundledExample?: boolean };

let GET: () => Promise<Response>;
let copy: string;

beforeAll(async () => {
  const dataDir = makeDataDir();
  copy = join(dataDir, "my-app");
  cpSync(join(DEFAULT_APPS_DIR, "starkeep.manifest.json"), join(copy, "starkeep.manifest.json"));
  writeAdminConfig(dataDir, { appParentDirs: [DEFAULT_APPS_DIR] });
  process.env.STARKEEP_DIR = dataDir;
  // Nothing listens here, so every status reads "unknown".
  process.env.STARKEEP_LOCAL_DATA_SERVER_URL = "http://127.0.0.1:9";
  ({ GET } = await import("../../src/routes/apps-list"));
});

async function list(): Promise<ListedApp[]> {
  return ((await (await GET()).json()) as { apps: ListedApp[] }).apps;
}

describe("the bundled example app", () => {
  it("is marked when found through core's example-app folder", async () => {
    const [app] = await list();
    expect(app).toMatchObject({ sourceDir: DEFAULT_APPS_DIR, bundledExample: true });
  });

  it("is not marked when the same app is found in a copy", async () => {
    writeAdminConfig(process.env.STARKEEP_DIR!, { appParentDirs: [copy] });
    const [app] = await list();
    expect(app?.sourceDir).toBe(copy);
    expect(app?.bundledExample).toBeUndefined();
  });
});
