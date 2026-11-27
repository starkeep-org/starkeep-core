/**
 * adminCredentialsOrSignIn's messages when the admin session is missing or
 * ended: each names the sign-in command once.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.STARKEEP_DIR = mkdtempSync(join(tmpdir(), "cli-cloud-sign-in-"));

const world = vi.hoisted(() => ({ reason: undefined as string | undefined, signedIn: false }));

vi.mock("@starkeep/operator/admin-session", async (original) => {
  const real = await original<typeof import("@starkeep/operator/admin-session")>();
  return {
    ...real,
    adminCredentials: async () => {
      if (world.signedIn) return { email: "admin@example.com" };
      throw new real.SignInRequired(world.reason);
    },
  };
});
vi.mock("../src/commands/account", () => ({
  loginAdmin: async () => {
    world.signedIn = true;
  },
}));

const { adminCredentialsOrSignIn } = await import("../src/cloud");
const { createIo } = await import("../src/io");

function io(interactive: boolean) {
  const lines: string[] = [];
  return {
    io: createIo({
      json: false,
      cwd: ".",
      interactive,
      stdout: (t) => lines.push(t),
      stderr: (t) => lines.push(t),
    }),
    lines,
  };
}

beforeEach(() => {
  world.reason = undefined;
  world.signedIn = false;
});

describe("adminCredentialsOrSignIn without a terminal", () => {
  it("names the sign-in once when no session exists (APP-LIFE-247)", async () => {
    await expect(adminCredentialsOrSignIn(io(false).io)).rejects.toMatchObject({
      message:
        "Sign in as the Starkeep admin first: run `starkeep login --admin`, or sign in in admin-web.",
      exitCode: 3,
    });
  });

  it("says why an ended session ended, then names the sign-in once (ACCESS-198)", async () => {
    world.reason = "The admin session ended after 12 hours without use. Sign in again.";
    await expect(adminCredentialsOrSignIn(io(false).io)).rejects.toMatchObject({
      message:
        "The admin session ended after 12 hours without use. Run `starkeep login --admin` first.",
      exitCode: 3,
    });
  });
});

describe("adminCredentialsOrSignIn at a terminal", () => {
  it("signs in on the way, saying only that it does (APP-LIFE-246)", async () => {
    const { io: out, lines } = io(true);
    await expect(adminCredentialsOrSignIn(out)).resolves.toEqual({ email: "admin@example.com" });
    expect(lines.join("")).toContain("Signing in as the admin first.");
    expect(lines.join("")).not.toContain("login --admin");
  });

  it("says why an ended session ended before it signs in", async () => {
    world.reason = "The admin session ended a day after its sign-in. Sign in again.";
    const { io: out, lines } = io(true);
    await adminCredentialsOrSignIn(out);
    expect(lines.join("")).toContain(
      "The admin session ended a day after its sign-in. Signing in as the admin first.",
    );
  });
});
