import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { liveDeployments, testRegion, type LiveDeployment } from "./region.js";

const live: LiveDeployment = {
  configPath: "/home/op/.starkeep/config.json",
  stackPrefix: "starkeep",
  region: "us-east-2",
};

describe("testRegion", () => {
  it("refuses an unset region and names the live region and a command that sets another", () => {
    expect(() => testRegion(undefined, [live])).toThrow(/STARKEEP_AWS_E2E_REGION is not set/);
    expect(() => testRegion("  ", [live])).toThrow(/STARKEEP_AWS_E2E_REGION is not set/);
    expect(() => testRegion(undefined, [live])).toThrow(
      /'starkeep' \(\/home\/op\/\.starkeep\/config\.json\) runs in us-east-2/,
    );
    expect(() => testRegion(undefined, [live])).toThrow(
      "echo 'STARKEEP_AWS_E2E_REGION=us-west-2' >> .env.local",
    );
  });

  it("suggests a region that no live deployment uses", () => {
    const west = { ...live, stackPrefix: "other", region: "us-west-2" };
    expect(() => testRegion(undefined, [live, west])).toThrow(
      "echo 'STARKEEP_AWS_E2E_REGION=eu-west-1' >> .env.local",
    );
  });

  it("refuses an unset region when no live deployment is configured", () => {
    expect(() => testRegion(undefined, [])).toThrow(/STARKEEP_AWS_E2E_REGION is not set/);
  });

  it("returns a region that no live deployment uses, with no warning", () => {
    expect(testRegion("us-west-2", [live])).toEqual({ region: "us-west-2" });
  });

  it("returns the live region with a warning that names the deployment and the fix", () => {
    const { region, warning } = testRegion("us-east-2", [live]);
    expect(region).toBe("us-east-2");
    expect(warning).toContain("STARKEEP_AWS_E2E_REGION is us-east-2");
    expect(warning).toContain("'starkeep' (/home/op/.starkeep/config.json)");
    expect(warning).toContain("STARKEEP_AWS_E2E_REGION=us-west-2");
  });
});

describe("liveDeployments", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "region-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const writeConfig = (sub: string, config: unknown) => {
    mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, sub, "config.json"), JSON.stringify(config));
    return join(dir, sub, "config.json");
  };

  it("reads the region from the user pool ID of the home config and STARKEEP_DIR's config", () => {
    const home = writeConfig(".starkeep", { stackPrefix: "starkeep", userPoolId: "us-east-2_abc" });
    const other = writeConfig("work", { stackPrefix: "work", userPoolId: "eu-west-1_def" });
    expect(liveDeployments(join(dir, "work"), dir)).toEqual([
      { configPath: home, stackPrefix: "starkeep", region: "us-east-2" },
      { configPath: other, stackPrefix: "work", region: "eu-west-1" },
    ]);
  });

  it("skips a missing config, a config with no cloud deployment and an unreadable one", () => {
    writeConfig(".starkeep", { appParentDirs: [] });
    mkdirSync(join(dir, "broken"));
    writeFileSync(join(dir, "broken", "config.json"), "{");
    expect(liveDeployments(join(dir, "broken"), dir)).toEqual([]);
    expect(liveDeployments(undefined, join(dir, "nowhere"))).toEqual([]);
  });
});
