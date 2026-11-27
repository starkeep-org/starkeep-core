/**
 * A throwaway Starkeep instance on its own ports, and stand-in apps in git
 * repositories, for the integration suites that drive `starkeep` end to end.
 *
 * Import this module before any module under `src/`: it sets STARKEEP_DIR and
 * the ports, which several modules read when they load.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const WRAPPER = join(CHECKOUT, "scripts", "starkeep.mjs");

// The real path, so paths the CLI prints after git resolves them match.
export const root = realpathSync(mkdtempSync(join(tmpdir(), "cli-scenarios-")));
export const dataDir = join(root, "dot-starkeep");
mkdirSync(dataDir);

/**
 * A port in a band of its own per run, so parallel suites rarely collide. The
 * bands end below 32768, where Linux starts handing out ephemeral ports.
 */
const base = 21_000 + Math.floor(Math.random() * 230) * 50;
process.env.STARKEEP_DIR = dataDir;
process.env.STARKEEP_PORT = String(base);
process.env.STARKEEP_DRIVE_PORT = String(base + 1);
process.env.STARKEEP_ADMIN_PORT = String(base + 2);
process.env.STARKEEP_APP_PORT_RANGE = `${base + 10}-${base + 49}`;
delete process.env.STARKEEP_LOCAL_DATA_SERVER_URL;
delete process.env.STARKEEP_DRIVE_URL;
delete process.env.INIT_CWD;

// The suites fetch from this worker, both directly and through the CLI that
// `answering` runs in-process. Every `starkeep` call blocks the worker in
// spawnSync, so fetch's pool cannot see that a server closed or restarted
// behind a kept-alive connection, and the next fetch fails on that dead socket.
// A real CLI run is a fresh process. Closing each connection matches that.
const pooledFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
  const headers = new Headers(
    init.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  headers.set("connection", "close");
  return pooledFetch(input, { ...init, headers });
}) as typeof fetch;

export interface Run {
  code: number;
  out: string;
  err: string;
}

/** Run the CLI through its wrapper, with no terminal attached. */
export function starkeep(args: string[], options: { cwd?: string } = {}): Run {
  const result = spawnSync(process.execPath, [WRAPPER, ...args], {
    cwd: options.cwd ?? root,
    env: process.env,
    encoding: "utf8",
    timeout: 300_000,
  });
  return { code: result.status ?? -1, out: result.stdout, err: result.stderr };
}

/** Run the CLI in this process, as a person at a terminal who types `answers`. */
export async function answering(args: string[], answers: string[]): Promise<Run> {
  const { main } = await import("../../src/main");
  let out = "";
  let err = "";
  const code = await main(args, {
    cwd: root,
    interactive: true,
    answers,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  });
  return { code, out, err };
}

/** The final `result` event of a `--json` run. */
export function result(out: string): {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { message: string };
} {
  const lines = out.trim().split("\n").filter(Boolean);
  return JSON.parse(lines.at(-1)!) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { message: string };
  };
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

export interface StandInOptions {
  version?: string;
  /** The shared types the app reads. A new type asks for different access. */
  reads?: string[];
  /** Extra package.json fields, such as a failing install script. */
  packageJson?: Record<string, unknown>;
}

const SERVER = `import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const version = readFileSync(new URL("./VERSION", import.meta.url), "utf8").trim();
createServer((_req, res) => res.end(version)).listen(port, "127.0.0.1", () =>
  console.log("listening on " + port),
);
`;

/** Write a stand-in app's files: a manifest, a tiny server, and its VERSION. */
export function writeStandIn(dir: string, id: string, options: StandInOptions = {}): void {
  mkdirSync(dir, { recursive: true });
  const reads = options.reads ?? ["image/png"];
  const manifest: Record<string, unknown> = {
    id,
    name: id[0]!.toUpperCase() + id.slice(1),
    version: "0.1.0",
    description: `The ${id} stand-in app.`,
    tier: "official",
    protocolMinVersion: "1.1.0",
    targets: ["local"],
    localRun: { command: "node", args: ["server.mjs"], portFlag: "--port" },
    infraRequirements: {
      fileAccess: reads.map((type) => ({
        types: [type],
        access: "read",
        rationale: `Reads the member's ${type} files.`,
      })),
    },
  };
  if (options.packageJson) {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: id, private: true, ...options.packageJson }, null, 2),
    );
    manifest.installDependencies = { command: "npm", args: ["install"] };
  }
  writeFileSync(join(dir, "starkeep.manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, "server.mjs"), SERVER);
  writeFileSync(join(dir, "VERSION"), `${options.version ?? "v1"}\n`);
}

export interface StandInRepo {
  /** The clone the person installs from. */
  clone: string;
  /** Where new upstream commits come from. */
  work: string;
  /** Commit a new version upstream. */
  publish(options: StandInOptions): void;
  head(): string;
}

/** A stand-in app in a clone that tracks an upstream, under `parent/<id>`. */
export function standInRepo(parent: string, id: string, options: StandInOptions = {}): StandInRepo {
  const work = join(root, "upstreams", `${id}-work`);
  const upstream = join(root, "upstreams", `${id}.git`);
  const clone = join(parent, id);
  writeStandIn(work, id, options);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "v1");
  execFileSync("git", ["clone", "-q", "--bare", work, upstream]);
  git(work, "remote", "add", "origin", upstream);
  git(work, "fetch", "-q", "origin");
  git(work, "branch", "-q", "--set-upstream-to=origin/main", "main");
  mkdirSync(parent, { recursive: true });
  execFileSync("git", ["clone", "-q", upstream, clone]);
  return {
    clone,
    work,
    publish(next) {
      writeStandIn(work, id, { ...options, ...next });
      git(work, "add", ".");
      git(work, "commit", "-q", "-m", next.version ?? "next");
      git(work, "push", "-q", "origin", "main");
    },
    head: () => git(clone, "rev-parse", "HEAD"),
  };
}

/** What an app serves on this computer, or null when nothing answers. */
export async function served(port: number): Promise<string | null> {
  try {
    return (await (await fetch(`http://127.0.0.1:${port}/`)).text()).trim();
  } catch {
    return null;
  }
}

/** The port `starkeep status --json` reports for a running service. */
export function portOf(name: string): number | null {
  const status = result(starkeep(["status", "--json"]).out);
  const services = status.data!.services as Array<{
    name: string;
    running: boolean;
    port?: number;
  }>;
  const entry = services.find((s) => s.name === name);
  return entry?.running && entry.port ? entry.port : null;
}
