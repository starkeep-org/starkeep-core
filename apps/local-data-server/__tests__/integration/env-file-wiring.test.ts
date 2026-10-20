/**
 * The headline of todo 40: a STARKEEP_DIR set in a repo-root `.env.local` (not
 * exported in the environment) must actually drive which directory the
 * local-data-server uses for all of its state — and two distinct values must
 * yield two completely separate instances.
 *
 * These spawn the real `server.ts` entry point with NO STARKEEP_DIR in the child
 * env (the harness's `loadDirFromEnvFile`), pointing `STARKEEP_ENV_DIR` at a
 * throwaway dir that contains a `.env.local`. So the only way the server can land
 * in the right directory is by loading the dotfile via
 * `@starkeep/app-client/load-env`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

// Make an env dir whose `.env.local` points STARKEEP_DIR at a fresh instance dir.
function makeEnvDir(): { envDir: string; instanceDir: string } {
  const envDir = mkdtempSync(join(tmpdir(), "starkeep-envdir-"));
  const instanceDir = mkdtempSync(join(tmpdir(), "starkeep-instance-"));
  writeFileSync(join(envDir, ".env.local"), `STARKEEP_DIR=${instanceDir}\n`);
  cleanups.push(() => rmSync(envDir, { recursive: true, force: true }));
  cleanups.push(() => rmSync(instanceDir, { recursive: true, force: true }));
  return { envDir, instanceDir };
}

async function startFromEnvFile(envDir: string): Promise<LocalDataServer> {
  const server = await startLocalDataServer({
    loadDirFromEnvFile: true,
    env: { STARKEEP_ENV_DIR: envDir },
  });
  cleanups.push(() => server.stopKeepData());
  return server;
}

describe("STARKEEP_DIR from .env.local", () => {
  it("the server resolves its data dir from .env.local (not the env var)", async () => {
    const { envDir, instanceDir } = makeEnvDir();
    const server = await startFromEnvFile(envDir);

    // It became healthy and wrote its state under the dir named only in the
    // dotfile — proving the loader ran before starkeepDir() was read.
    expect(existsSync(join(instanceDir, "data.db"))).toBe(true);
    expect(server.logs()).not.toMatch(/Refusing to use the operator's real/);
  });

  it("two different .env.local values give two completely separate instances", async () => {
    const a = makeEnvDir();
    const b = makeEnvDir();
    expect(a.instanceDir).not.toBe(b.instanceDir);

    const serverA = await startFromEnvFile(a.envDir);
    const serverB = await startFromEnvFile(b.envDir);

    // Both up at once, each with its own on-disk database under its own root.
    expect(serverA.port).not.toBe(serverB.port);
    expect(existsSync(join(a.instanceDir, "data.db"))).toBe(true);
    expect(existsSync(join(b.instanceDir, "data.db"))).toBe(true);
    // Neither instance leaked a database into the other's root.
    expect(existsSync(join(a.instanceDir, "config.json"))).toBe(true);
    expect(existsSync(join(b.instanceDir, "config.json"))).toBe(true);
  });
});
