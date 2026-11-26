/**
 * `starkeep cloud cost`'s table and month flag, and `starkeep doctor`'s
 * checks, each with its fix.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "cli-cost-doctor-"));
process.env.STARKEEP_DIR = dir;

const costs = vi.hoisted(() => ({
  answer: null as null | Array<{ service: string; amount: number }> | Error,
  months: [] as Date[],
}));
vi.mock("@starkeep/operator/costs", async (original) => ({
  ...(await original<typeof import("@starkeep/operator/costs")>()),
  fetchMtdCostsByService: async (_c: unknown, _p: string, _r: string, month: Date) => {
    costs.months.push(month);
    if (costs.answer instanceof Error) throw costs.answer;
    return costs.answer;
  },
}));
vi.mock("@starkeep/operator/admin-session", async (original) => ({
  ...(await original<typeof import("@starkeep/operator/admin-session")>()),
  adminCredentials: async () => ({
    stsCredentials: { accessKeyId: "A", secretAccessKey: "s", sessionToken: "t", expiration: "" },
    sub: "sub-admin",
    region: "us-east-2",
    email: "admin@example.com",
  }),
}));

const { main } = await import("../src/main");
const { costLines, monthOf } = await import("../src/commands/costs");
const { checkConfig, checkNode, checkPorts, checkTool, portInUse } =
  await import("../src/commands/doctor");

async function run(...argv: string[]) {
  let out = "";
  let err = "";
  const code = await main(argv, {
    cwd: dir,
    interactive: false,
    stdout: (t) => void (out += t),
    stderr: (t) => void (err += t),
  });
  return { code, out, err };
}

describe("cloud cost", () => {
  it("lists each service from the largest cost down, with the projection and the totals", () => {
    const lines = costLines(
      [
        { service: "S3", amount: 0.3 },
        { service: "Lambda", amount: 1.2 },
      ],
      [
        { service: "S3", amount: 0.6 },
        { service: "Lambda", amount: 2.4 },
      ],
    );
    expect(lines[0]).toMatch(/^SERVICE\s+MONTH-TO-DATE\s+PROJECTED$/);
    expect(lines[1]).toMatch(/^Lambda\s+\$1\.20\s+\$2\.40$/);
    expect(lines[2]).toMatch(/^S3\s+\$0\.30\s+\$0\.60$/);
    expect(lines[3]).toMatch(/^Total\s+\$1\.50\s+\$3\.00$/);
  });

  it("leaves the projection out for a past month", () => {
    expect(costLines([{ service: "Lambda", amount: 1 }], null)[0]).not.toContain("PROJECTED");
  });

  it("reads the month --month names, and refuses a malformed one with exit status 2", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ stackPrefix: "sk" }));
    costs.answer = [{ service: "Lambda", amount: 1 }];
    const { code, out } = await run("cloud", "cost", "--month", "2026-10");
    expect(code).toBe(0);
    expect(costs.months.at(-1)).toEqual(new Date(2026, 9, 1));
    expect(out).toContain("Includes both Starkeep and non-Starkeep service costs.");
    expect(out).not.toContain("PROJECTED");
    expect(monthOf("2026-11")).toEqual(new Date(2026, 10, 1));
    const bad = await run("cloud", "cost", "--month", "2026-13");
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("--month takes a month as YYYY-MM");
  });

  it("says the report has not arrived yet when there is none, or no billing bucket", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ stackPrefix: "sk" }));
    costs.answer = null;
    expect((await run("cloud", "cost")).out).toContain(
      "Cost report configured — data arrives within 24 hours.",
    );
    costs.answer = Object.assign(new Error("no bucket"), { name: "NoSuchBucket" });
    expect((await run("cloud", "cost")).out).toContain("data arrives within 24 hours");
  });

  it("says a past month has no report, rather than that one is on its way", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ stackPrefix: "sk" }));
    costs.answer = null;
    const { code, out } = await run("cloud", "cost", "--month", "2025-01");
    expect(code).toBe(0);
    expect(out).toContain("No cost report covers 2025-01.");
    expect(out).not.toContain("data arrives within 24 hours");
  });
});

describe("doctor", () => {
  it("fails a Node older than 24 and names the fix", () => {
    expect(checkNode("22.1.0")).toMatchObject({ level: "fail", fix: "nvm install 24" });
    expect(checkNode("24.3.0").level).toBe("ok");
  });

  it("fails a missing tool and names the fix", () => {
    expect(checkTool("pnpm", "pnpm", "npm install -g pnpm@10", null)).toMatchObject({
      level: "fail",
      detail: "no `pnpm` on PATH",
      fix: "npm install -g pnpm@10",
    });
  });

  it("fails a port another program holds, and passes one a Starkeep service holds", async () => {
    const results = await checkPorts(
      async (id) => ({ running: id === "drive" }),
      async () => true,
    );
    expect(results.find((r) => r.detail.includes("drive"))).toMatchObject({
      level: "ok",
      detail: "drive runs on it",
    });
    expect(results.find((r) => r.detail.includes("data-server"))).toMatchObject({
      level: "fail",
      detail: "another program holds data-server's port",
    });
    expect(results.find((r) => r.detail.includes("data-server"))?.fix).toContain("STARKEEP_PORT");
  });

  it("sees a port held by another program", async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    expect(await portInUse(port)).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await portInUse(port)).toBe(false);
  });

  it("fails a config.json that does not parse, or whose cloud fields disagree", () => {
    const path = join(dir, "doctor-config.json");
    writeFileSync(path, "{ not json");
    expect(checkConfig(path, () => null)).toMatchObject({ level: "fail" });
    writeFileSync(path, "{}");
    expect(checkConfig(path, () => ({ userPoolId: "us-east-2_abc" }))).toMatchObject({
      level: "fail",
      detail:
        "a user pool but no stackPrefix; a user pool but no userPoolClientId; a user pool but no identityPoolId",
      fix: "run `starkeep setup --cloud` again, which records the missing fields",
    });
    expect(
      checkConfig(path, () => ({
        stackPrefix: "sk",
        userPoolId: "us-east-2_abc",
        userPoolClientId: "c",
        identityPoolId: "i",
      })),
    ).toMatchObject({ level: "ok", detail: "names the cloud sk in us-east-2" });
  });

  it("exits 1 when a check fails, with every check in the --json result", async () => {
    writeFileSync(join(dir, "config.json"), "{ not json");
    const { code, out } = await run("doctor", "--json");
    expect(code).toBe(1);
    const result = JSON.parse(out.trim().split("\n").at(-1)!) as {
      ok: boolean;
      data: { checks: Array<{ name: string; level: string }> };
    };
    expect(result.ok).toBe(false);
    expect(result.data.checks.find((c) => c.name === "config.json")?.level).toBe("fail");
    expect(result.data.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(["Node", "pnpm", "git", "Install"]),
    );
  });
});
