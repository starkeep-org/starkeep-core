/**
 * Start runs an installed app from the folder Install pinned, with the
 * manifest the user approved, whatever the scan finds now.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import {
  jsonRequest,
  makeAppDir,
  makeDataDir,
  testAppManifest,
  writeAdminConfig,
} from "../helpers";

let daemonPOST: (req: Request) => Promise<Response>;
let lds: LocalDataServer;
let pinnedDir: string;
let goneDir: string;

/** An app folder whose server answers with `label`, so a test can tell copies apart. */
function serverApp(parent: string, dir: string, id: string, label: string): string {
  const appDir = makeAppDir(
    parent,
    dir,
    testAppManifest({
      id,
      localRun: { command: process.execPath, args: ["server.mjs"], portFlag: "--port" },
    }),
  );
  writeFileSync(
    join(appDir, "server.mjs"),
    `import { createServer } from "node:http";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
createServer((req, res) => res.end(${JSON.stringify(label)})).listen(port, "127.0.0.1");
`,
  );
  return appDir;
}

async function install(manifest: Record<string, unknown>, sourceDir?: string): Promise<void> {
  const res = await fetch(`${lds.url}/admin/apps/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ manifest, ...(sourceDir ? { sourceDir } : {}) }),
  });
  expect(res.ok).toBe(true);
}

beforeAll(async () => {
  const dataDir = makeDataDir();
  const parent = join(dataDir, "apps");
  writeAdminConfig(dataDir, { appParentDirs: [parent] });

  // Installed from a folder outside the scan; a second copy sits in the
  // scanned folder.
  pinnedDir = serverApp(join(dataDir, "elsewhere"), "pinned", "pinned-app", "pinned copy");
  serverApp(parent, "pinned-copy", "pinned-app", "scanned copy");

  // Installed before the registry pinned folders: no sourceDir.
  serverApp(parent, "legacy", "legacy-app", "legacy");

  goneDir = serverApp(dataDir, "gone", "gone-app", "gone");

  lds = await startLocalDataServer();
  process.env.STARKEEP_DIR = dataDir;
  process.env.STARKEEP_LOCAL_DATA_SERVER_URL = lds.url;
  const manifestOf = (id: string) =>
    testAppManifest({
      id,
      localRun: { command: process.execPath, args: ["server.mjs"], portFlag: "--port" },
    });
  await install(manifestOf("pinned-app"), pinnedDir);
  await install(manifestOf("legacy-app"));
  await install(manifestOf("gone-app"), goneDir);
  rmSync(goneDir, { recursive: true });

  daemonPOST = (await import("../../src/routes/exec-daemon")).POST;
});

afterAll(async () => {
  for (const id of ["pinned-app", "legacy-app"]) {
    await daemonPOST(jsonRequest("/api/exec/daemon", { action: "stop", id }));
  }
  await lds.stop();
});

async function startAndAsk(id: string): Promise<string> {
  const res = await daemonPOST(jsonRequest("/api/exec/daemon", { action: "start", id }));
  expect(res.status).toBe(200);
  const { port } = (await res.json()) as { port: number };
  return (await fetch(`http://127.0.0.1:${port}/`)).text();
}

describe("Start for an installed app", () => {
  it("runs the pinned folder, not another folder the scan finds with the same id", async () => {
    expect(await startAndAsk("pinned-app")).toBe("pinned copy");
  });

  it("runs an app with no pinned folder from the scan", async () => {
    expect(await startAndAsk("legacy-app")).toBe("legacy");
  });

  it("refuses an app whose pinned folder is gone, naming the folder", async () => {
    const res = await daemonPOST(
      jsonRequest("/api/exec/daemon", { action: "start", id: "gone-app" }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain(goneDir);
  });
});
