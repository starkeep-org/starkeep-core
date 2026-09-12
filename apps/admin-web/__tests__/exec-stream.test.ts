/**
 * POST /api/exec/stream — a workspace command, streamed to the browser.
 *
 * This is the simplest of the four streaming routes and the one whose command
 * list is the most dangerous to run for real: `reset-local-data` deletes the
 * operator's objects, database and watch configs. The child is faked, so what
 * this file asserts is the contract above it — which command runs, what
 * credentials reach it, how its output is framed, and what the terminal events
 * are.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, makeDataDir } from "./helpers";
import { lastChild, resetSpawns, spawnedChildren } from "./fake-spawn";
import { lines, readSse } from "./sse";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: (await import("./fake-spawn")).fakeSpawn,
}));

process.env.STARKEEP_DIR = makeDataDir("adminweb-exec-stream-");

const { POST: rawPOST } = await import("../src/routes/exec-stream");
const { REPO_ROOT, STREAM_COMMANDS } = await import("../src/lib/exec-commands");
const POST = rawPOST;

const CREDENTIALS = {
  accessKeyId: "AKIA",
  secretAccessKey: "secret",
  sessionToken: "token",
  region: "us-east-2",
};

const call = (body: unknown) => POST(jsonRequest("/api/exec/stream", body));

beforeEach(() => {
  resetSpawns();
});

describe("refusals, which happen before anything is spawned", () => {
  it("refuses a command id that is not in the list", async () => {
    const res = await call({ id: "rm-rf-slash" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("Unknown command ID");
    expect(spawnedChildren()).toHaveLength(0);
  });

  it("refuses a command that needs credentials when none were sent", async () => {
    const res = await call({ id: "local-deploy" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("Credentials required");
    expect(spawnedChildren()).toHaveLength(0);
  });
});

describe("what gets spawned", () => {
  it("runs the command from the list, from the repo root", async () => {
    await call({ id: "reset-local-data" });
    const child = lastChild();
    const [executable, ...args] = STREAM_COMMANDS["reset-local-data"].args;
    expect(child.command).toBe(executable);
    expect(child.args).toEqual(args);
    expect(child.options.cwd).toBe(REPO_ROOT);
  });

  it("puts the caller's credentials in the child's environment, not on its argv", async () => {
    // They are secrets, and argv is world-readable in `ps`.
    await call({ id: "local-deploy", credentials: CREDENTIALS });
    const child = lastChild();
    expect(child.options.env).toMatchObject({
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "token",
      AWS_REGION: "us-east-2",
    });
    expect(child.args.join(" ")).not.toContain("secret");
  });

  it("leaves the environment alone for a command that needs no credentials", async () => {
    await call({ id: "reset-local-data" });
    expect(lastChild().options.env).not.toHaveProperty("AWS_SESSION_TOKEN");
  });

  it("answers as an event stream the browser will not cache", async () => {
    const res = await call({ id: "reset-local-data" });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });
});

describe("framing", () => {
  it("sends one data frame per line of output, JSON-encoded", async () => {
    const res = await call({ id: "reset-local-data" });
    const child = lastChild();
    const stream = readSse(res);
    child.say("Removing objects…\nRemoving data.db\n");
    expect(await stream.next()).toEqual({ event: "message", data: '"Removing objects…"' });
    expect(await stream.next()).toEqual({ event: "message", data: '"Removing data.db"' });
    child.exit(0);
    await stream.rest();
  });

  it("JSON-encodes a line, so a line carrying a newline cannot forge a frame", async () => {
    const res = await call({ id: "reset-local-data" });
    const child = lastChild();
    const stream = readSse(res);
    child.say(`error: unexpected "quote" and \\backslash\n`);
    const frame = await stream.next();
    expect(JSON.parse(frame!.data)).toBe(`error: unexpected "quote" and \\backslash`);
    child.exit(0);
    await stream.rest();
  });

  it("interleaves stderr into the same stream", async () => {
    const res = await call({ id: "reset-local-data" });
    const child = lastChild();
    const stream = readSse(res);
    child.say("step one\n");
    child.sayErr("warning: nothing to remove\n");
    child.exit(0);
    expect(lines(await stream.rest())).toEqual(["step one", "warning: nothing to remove"]);
  });

  it("drops the empty line a trailing newline produces", async () => {
    const res = await call({ id: "reset-local-data" });
    const child = lastChild();
    const stream = readSse(res);
    child.say("only line\n\n");
    child.exit(0);
    expect(lines(await stream.rest())).toEqual(["only line"]);
  });
});

describe("the terminal events", () => {
  it("ends with done carrying the exit code", async () => {
    const res = await call({ id: "reset-local-data" });
    const child = lastChild();
    const stream = readSse(res);
    child.exit(0);
    const events = await stream.rest();
    expect(events.at(-1)).toEqual({ event: "done", data: "0" });
  });

  it("reports a non-zero exit in the done event rather than as an error", async () => {
    // The client decides what a failing script means; the route's job is to say
    // what happened. A script that exits 3 is not the stream failing.
    const res = await call({ id: "reset-local-data" });
    const child = lastChild();
    const stream = readSse(res);
    child.say("could not remove data.db\n");
    child.exit(3);
    const events = await stream.rest();
    expect(events.at(-1)).toEqual({ event: "done", data: "3" });
  });

  it("reports a signalled exit as 1, since there is no code to report", async () => {
    const res = await call({ id: "reset-local-data" });
    const child = lastChild();
    const stream = readSse(res);
    child.exit(null);
    expect((await stream.rest()).at(-1)).toEqual({ event: "done", data: "1" });
  });

  it("ends with error when the command could not be spawned at all", async () => {
    const res = await call({ id: "reset-local-data" });
    const child = lastChild();
    const stream = readSse(res);
    child.fail("spawn bash ENOENT");
    const events = await stream.rest();
    expect(events.at(-1)!.event).toBe("error");
    expect(JSON.parse(events.at(-1)!.data)).toContain("ENOENT");
  });

  it("closes the stream after the terminal event", async () => {
    const res = await call({ id: "reset-local-data" });
    const child = lastChild();
    const stream = readSse(res);
    child.exit(0);
    await stream.rest();
    expect(await stream.next()).toBeNull();
  });
});
