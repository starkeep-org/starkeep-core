/**
 * Which local services the person wants running: `~/.starkeep/services.json`.
 *
 * admin-web's Start and Stop buttons and the CLI's `start` and `stop` both
 * write the file, so `starkeep start` with no names brings back what either
 * tool left running.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";

interface ServicesFile {
  /** Service ids in the order the person first asked for them. */
  wanted: string[];
}

export function servicesFile(): string {
  return join(starkeepDir(), "services.json");
}

function read(): ServicesFile {
  try {
    const parsed = JSON.parse(readFileSync(servicesFile(), "utf8")) as Partial<ServicesFile>;
    return {
      wanted: Array.isArray(parsed.wanted)
        ? parsed.wanted.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return { wanted: [] };
  }
}

function write(file: ServicesFile): void {
  const path = servicesFile();
  mkdirSync(starkeepDir(), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/** The services the person wants running. */
export function wantedServices(): string[] {
  return read().wanted;
}

/** Record that the person wants `id` running, or stopped. */
export function recordWanted(id: string, running: boolean): void {
  const file = read();
  const has = file.wanted.includes(id);
  if (running && !has) file.wanted.push(id);
  else if (!running && has) file.wanted = file.wanted.filter((w) => w !== id);
  else return;
  write(file);
}
