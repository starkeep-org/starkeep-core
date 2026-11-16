/**
 * The region the cloud suites deploy the test stack in.
 *
 * The region has no default. A test stack in the region of a live deployment
 * shares every regional service with it, so a teardown command that names the
 * wrong prefix reaches the live deployment's regional resources. Naming the
 * region on purpose keeps the choice visible, and the warning below catches a
 * choice that puts the test stack beside a live deployment.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LiveDeployment {
  configPath: string;
  stackPrefix: string;
  region: string;
}

/** Regions that offer Aurora DSQL, in the order the error suggests them. */
const SUGGESTED_REGIONS = ["us-west-2", "eu-west-1", "us-east-2"];

/**
 * The operator's own deployments: the default `~/.starkeep/config.json` and the
 * config that `STARKEEP_DIR` names. A user pool ID carries its region. A config
 * with no user pool, or one that does not parse, names no deployment.
 */
export function liveDeployments(
  starkeepDir: string | undefined = process.env.STARKEEP_DIR,
  home: string = homedir(),
): LiveDeployment[] {
  const paths = new Set([join(home, ".starkeep", "config.json")]);
  if (starkeepDir) paths.add(join(starkeepDir, "config.json"));
  const found: LiveDeployment[] = [];
  for (const configPath of paths) {
    if (!existsSync(configPath)) continue;
    let config: { stackPrefix?: unknown; userPoolId?: unknown };
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      continue;
    }
    const pool = typeof config.userPoolId === "string" ? config.userPoolId : "";
    const separator = pool.indexOf("_");
    if (separator <= 0) continue;
    found.push({
      configPath,
      stackPrefix: typeof config.stackPrefix === "string" ? config.stackPrefix : "",
      region: pool.slice(0, separator),
    });
  }
  return found;
}

/**
 * The requested test region, checked against the live deployments. An unset
 * region throws. A region that a live deployment uses comes back with a
 * warning to print, and the run goes on.
 */
export function testRegion(
  requested: string | undefined,
  live: LiveDeployment[],
): { region: string; warning?: string } {
  const liveRegions = new Set(live.map((d) => d.region));
  const suggestion = SUGGESTED_REGIONS.find((r) => !liveRegions.has(r)) ?? SUGGESTED_REGIONS[0];
  const describe = (d: LiveDeployment) =>
    `'${d.stackPrefix || "<no prefix>"}' (${d.configPath}) runs in ${d.region}`;
  const setCommand = `echo 'STARKEEP_AWS_E2E_REGION=${suggestion}' >> .env.local`;

  const region = requested?.trim();
  if (!region) {
    const where = live.length
      ? `Your live deployment ${live.map(describe).join(", and ")}.`
      : "No live deployment config was found, so check the account for live deployments yourself.";
    throw new Error(
      [
        "STARKEEP_AWS_E2E_REGION is not set. The cloud suites have no default region for the test stack.",
        `Choose a region that no live deployment uses. ${where}`,
        "Set the region once, from the repository root:",
        `  ${setCommand}`,
        "The region must offer Aurora DSQL. An exported STARKEEP_AWS_E2E_REGION overrides .env.local.",
      ].join("\n"),
    );
  }

  const sharing = live.filter((d) => d.region === region);
  if (!sharing.length) return { region };
  return {
    region,
    warning: [
      `WARNING: STARKEEP_AWS_E2E_REGION is ${region}, and your live deployment ${sharing.map(describe).join(", and ")}.`,
      "The test stack shares every regional service with that deployment, so a teardown",
      "command that names the wrong prefix reaches the live deployment's regional resources.",
      `To move the tests, tear down the test stack, then set STARKEEP_AWS_E2E_REGION=${suggestion}`,
      "in the repository's .env.local. The run continues.",
    ].join("\n"),
  };
}
