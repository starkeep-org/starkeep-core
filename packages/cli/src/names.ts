/**
 * One name space for services and apps: `data-server`, `drive`, then app ids.
 * `starkeep start drive` means the Drive service, and any other name is an
 * installed app's id.
 */
import { isWorkspaceDaemonId } from "@starkeep/operator/daemons";

const ALIASES: Record<string, string> = {
  "data-server": "local-data-server",
  "local-data-server": "local-data-server",
  drive: "drive",
};

/** The workspace daemons, in the order they start. */
export const PLATFORM_SERVICES = ["local-data-server", "drive"] as const;

/** The id a typed name stands for. */
export function serviceId(name: string): string {
  return ALIASES[name] ?? name;
}

/** The name a person types for an id. */
export function displayName(id: string): string {
  return id === "local-data-server" ? "data-server" : id;
}

/** Platform services first, in their fixed order, then apps by id. */
export function startOrder(ids: Iterable<string>): string[] {
  const unique = [...new Set(ids)];
  const platform = PLATFORM_SERVICES.filter((p) => unique.includes(p));
  const apps = unique.filter((id) => !isWorkspaceDaemonId(id)).sort();
  return [...platform, ...apps];
}
