#!/usr/bin/env tsx
/**
 * data-server-ctl — CLI for managing the running data-server.
 *
 * Usage:
 *   data-server-ctl watch add <dirPath> [--no-recursive]
 *   data-server-ctl watch remove <watchId>
 *   data-server-ctl watch list
 */

const PORT = process.env.STARKEEP_PORT ?? "9820";
const BASE_URL = `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command: string;
  subcommand: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let command = "";
  let subcommand = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--no-")) {
      flags[arg.slice(5)] = false;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  command = positional[0] ?? "";
  subcommand = positional[1] ?? "";

  return { command, subcommand, positional: positional.slice(2), flags };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    console.error(`Could not connect to data-server at localhost:${PORT}`);
    console.error("Make sure the data-server is running (npm run dev).");
    process.exit(1);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error(`Error ${response.status}: ${text || response.statusText}`);
    process.exit(1);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function watchAdd(dirPath: string, recursive: boolean): Promise<void> {
  const watch = await request("POST", "/watches", {
    directoryPath: dirPath,
    recursive,
  }) as { id: string; content?: { directoryPath?: string; recursive?: boolean } };

  const id = watch.id ?? "?";
  const content = watch.content ?? {};
  console.log("Watch added:");
  console.log(`  id:        ${id}`);
  console.log(`  path:      ${content.directoryPath ?? dirPath}`);
  console.log(`  recursive: ${content.recursive ?? recursive}`);
}

async function resolveWatchId(idOrPath: string): Promise<string> {
  if (!idOrPath.startsWith("/")) return idOrPath;
  const status = await request("GET", `/watches/directory-status?path=${encodeURIComponent(idOrPath)}`) as {
    watched: boolean;
    watchId?: string;
  };
  if (!status.watched || !status.watchId) {
    console.error(`No watch found for path: ${idOrPath}`);
    process.exit(1);
  }
  return status.watchId;
}

async function watchRemove(idOrPath: string): Promise<void> {
  const watchId = await resolveWatchId(idOrPath);
  await request("DELETE", `/watches/${watchId}`);
  console.log(`Watch ${watchId} removed.`);
}

async function watchList(): Promise<void> {
  const watches = await request("GET", "/watches") as Array<{
    id: string;
    directoryPath: string;
    state: string;
    totalFiles: number;
    syncedFiles: number;
  }>;

  if (watches.length === 0) {
    console.log("No watches configured.");
    return;
  }

  console.log(`Watches (${watches.length}):`);
  for (const w of watches) {
    const id = w.id.padEnd(26);
    const path = (w.directoryPath ?? "").padEnd(40);
    const state = (w.state ?? "").padEnd(10);
    console.log(`  ${id}  ${path}  ${state}  ${w.syncedFiles ?? 0}/${w.totalFiles ?? 0} files`);
  }
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`Usage:
  data-server-ctl watch add <dirPath> [--no-recursive]
  data-server-ctl watch remove <watchId>
  data-server-ctl watch list

Options:
  --no-recursive  Do not watch subdirectories (default: recursive)

Environment:
  STARKEEP_PORT  Port of the running data-server (default: 9820)`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { command, subcommand, positional, flags } = parseArgs(process.argv);

  if (command === "watch") {
    if (subcommand === "add") {
      const dirPath = positional[0];
      if (!dirPath) {
        console.error("Error: dirPath is required.\n");
        printUsage();
        process.exit(1);
      }
      const recursive = (flags["recursive"] as boolean | undefined) ?? true;
      await watchAdd(dirPath, recursive);
    } else if (subcommand === "remove") {
      const watchId = positional[0];
      if (!watchId) {
        console.error("Error: watchId is required.\n");
        printUsage();
        process.exit(1);
      }
      await watchRemove(watchId);
    } else if (subcommand === "list") {
      await watchList();
    } else {
      console.error(`Unknown subcommand: ${subcommand}\n`);
      printUsage();
      process.exit(1);
    }
  } else {
    printUsage();
    if (command) process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
