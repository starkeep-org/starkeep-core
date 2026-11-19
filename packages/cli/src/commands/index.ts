import type { Command } from "../command";
import { infoCommand, installCommand, listCommand, sourceCommand, uninstallCommand } from "./apps";
import {
  adminCommand,
  logsCommand,
  restartCommand,
  startCommand,
  statusCommand,
  stopCommand,
} from "./services";
import { resetLocalCommand, setupCommand } from "./setup";
import { updateCommand } from "./update";

/** Every command, in the order `starkeep help` lists them. */
export const COMMANDS: Command[] = [
  setupCommand,
  startCommand,
  stopCommand,
  restartCommand,
  statusCommand,
  logsCommand,
  adminCommand,
  listCommand,
  infoCommand,
  installCommand,
  uninstallCommand,
  updateCommand,
  sourceCommand,
  resetLocalCommand,
];
