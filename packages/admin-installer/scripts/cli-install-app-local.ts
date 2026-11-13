#!/usr/bin/env tsx
/**
 * Install a Starkeep app on this computer from the terminal, the way Admin's
 * Install button does.
 *
 * The script shows the same consent words as Admin's install dialog: the files
 * the app may read and write, whether it can create public links, and the
 * dependency install it runs. Nothing happens until the person approves. Then
 * the script installs the app's dependencies, registers the app with the local
 * data server, and writes the app's credentials file.
 *
 * The local data server must be running. The script leaves the library's
 * archive quality as it is; Admin's Storage page changes it.
 *
 * Usage, from the root of starkeep-core:
 *   pnpm --filter @starkeep/admin-installer cli:install-app-local <app folder>
 *   pnpm --filter @starkeep/admin-installer cli:install-app-local <app folder> --yes
 *
 * `--yes` approves without asking, for a script that has already shown the
 * person the consent words. Without a terminal, the script requires `--yes`.
 */

// First import: load repo-root .env / .env.local so STARKEEP_DIR and
// STARKEEP_PORT match what Admin and the data server use.
import "@starkeep/app-client/load-env";
import { spawnSync } from "node:child_process";
import { readFolderManifest, typedPath } from "../src/app-discovery";
import {
  resolveInstallCommand,
  unattendedArgs,
  type CommandSource,
} from "../src/approved-commands";
import { categoriesOf, grantPermissions, publicSharingConsent } from "../src/consent-text";
import { installLocalApp } from "../src/local-app-install";
import { prompt } from "../src/cli-prompt";

const args = process.argv.slice(2);
const yes = args.includes("--yes");
const positional = args.filter((a) => !a.startsWith("--"));
if (positional.length !== 1) {
  console.error("Usage: cli:install-app-local <app folder> [--yes]");
  process.exit(2);
}
const appDir = typedPath(positional[0]!);

const dataServerUrl =
  process.env.STARKEEP_LOCAL_DATA_SERVER_URL ??
  `http://127.0.0.1:${process.env.STARKEEP_PORT ?? "9820"}`;

const folder = readFolderManifest(appDir);
if (folder.kind === "missing") {
  console.error(`${appDir} holds no starkeep.manifest.json.`);
  process.exit(1);
}
if (folder.kind === "invalid") {
  console.error(`The app's manifest failed validation: ${folder.error}`);
  process.exit(1);
}
const manifest = folder.manifest;
const name = manifest.name ?? manifest.id;

// The data server answers before anything runs, so a stopped server fails
// here rather than after a dependency install.
const health = await fetch(`${dataServerUrl}/health`).catch(() => null);
if (!health?.ok) {
  console.error(
    `The local data server at ${dataServerUrl} is not answering. Start it from Admin, then try again.`,
  );
  process.exit(1);
}

// The consent words, in the order Admin's dialog shows them.
const ir = manifest.infraRequirements;
const grants = ir?.fileAccess ?? [];
console.log(`\nInstall ${name}?\n`);
if (ir?.fileAccessAll) {
  console.log(
    "This app is the User-Data-Owner: read + write access to all files, including unclassified ones.",
  );
} else if (grants.length === 0) {
  console.log(`${name} doesn't access any of your files.`);
} else {
  console.log(`${name} asks for access to these files.`);
  for (const g of grants) {
    const { files, metadata } = grantPermissions(g);
    console.log(`  - ${categoriesOf(g.types)}: files ${files}, metadata ${metadata}`);
    console.log(`    ${g.types.map((t) => t.split("/")[1] ?? t).join(", ")}`);
  }
}
const publicLinks = publicSharingConsent(manifest);
if (publicLinks) console.log(`\nPublic links: ${publicLinks}`);

const install = resolveInstallCommand(appDir, folder.raw as CommandSource);
if (install.kind === "run") {
  console.log(
    `\nInstall runs \`${install.display}\` in ${install.cwd}, which runs the app's own install scripts.`,
  );
} else if (install.kind === "refused") {
  console.log(
    `\nInstall will not run \`${install.display}\`: ${install.reason} Run it yourself in ${install.cwd}.`,
  );
}

if (!yes) {
  if (!process.stdin.isTTY) {
    console.error("\nNo terminal to ask for approval. Pass --yes to approve.");
    process.exit(1);
  }
  const answer = await prompt("\nApprove and install? [y/N] ");
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log("Not installed.");
    process.exit(0);
  }
}

if (install.kind === "run") {
  console.log(`\nInstalling dependencies (${install.display} in ${install.cwd})…`);
  const result = spawnSync(install.command, unattendedArgs(install.command, install.args), {
    cwd: install.cwd,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`Dependency install failed (${install.display} exited ${result.status}).`);
    process.exit(result.status ?? 1);
  }
}

const result = await installLocalApp({ manifest: folder.raw, sourceDir: appDir, dataServerUrl });
if (!result.ok) {
  console.error(result.error);
  for (const detail of result.details ?? []) console.error(`  - ${detail}`);
  process.exit(1);
}
console.log(`\nInstalled ${name}. Its credentials are in ${result.secretPath}.`);
console.log(
  `Start ${name} from Admin. If ${name} was already running, restart it so it reads its new credentials.`,
);
