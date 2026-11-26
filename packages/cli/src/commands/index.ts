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
import { loginCommand, logoutCommand } from "./account";
import { cloudBootstrapUpdateCommand, cloudStatusCommand } from "./cloud";
import { cloudCostCommand } from "./costs";
import { doctorCommand } from "./doctor";
import { USER_COMMANDS } from "./users";

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
  loginCommand,
  logoutCommand,
  cloudStatusCommand,
  cloudBootstrapUpdateCommand,
  cloudCostCommand,
  ...USER_COMMANDS,
  resetLocalCommand,
  doctorCommand,
];
