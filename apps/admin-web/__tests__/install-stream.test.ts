/**
 * The three install routes that stream a Pulumi run to the browser:
 * `/api/cloud-data-server/install`, `/api/drive/install` and
 * `/api/apps/[appId]/cloud-install`.
 *
 * They share one design and it is the interesting part. Each runs its
 * installer **detached**, with the run's output and exit code on disk under
 * `~/.starkeep/installs/` (see `src/lib/detached-run.ts`). A browser which
 * suspends — a closed laptop during a ten-minute deploy — reattaches to the run
 * in progress instead of starting a second one on top of it, and so does a
 * browser whose admin-web restarted mid-run. A second concurrent Pulumi run
 * against one stack is the failure this prevents.
 *
 * The child is faked (see `fake-spawn.ts`); these routes really do run Pulumi
 * against an AWS account otherwise.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jsonRequest, makeDataDir } from "./helpers";
import { lastChild, resetSpawns, spawnedChildren, type FakeChild } from "./fake-spawn";
import { lines, readSse } from "./sse";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: (await import("./fake-spawn")).fakeSpawn,
}));

const dataDir = makeDataDir("adminweb-install-stream-");
const configPath = join(dataDir, "config.json");
process.env.STARKEEP_DIR = dataDir;

/** Everything the two later passes require of the earlier one. */
const FULL_CONFIG = {
  stackPrefix: "sktest",
  userPoolId: "us-east-2_abc123",
  auroraEndpoint: "abc.dsql.us-east-2.on.aws",
  s3Bucket: "sktest-files",
  apiGatewayId: "gw123",
  apiGatewayUrl: "https://gw123.execute-api.us-east-2.amazonaws.com",
  publicBaseUrl: "https://d111.cloudfront.net",
  authorizerId: "auth123",
  sessionAuthorizerId: "sess123",
  apiGatewayExecutionArn: "arn:aws:execute-api:us-east-2:1:gw123",
};

function writeConfig(config: unknown): void {
  writeFileSync(configPath, typeof config === "string" ? config : JSON.stringify(config));
}

type Call = (body?: Record<string, unknown>) => Promise<Response>;

const CREDS = { accessKeyId: "AKIA", secretAccessKey: "secret", sessionToken: "token" };

let cloudDataServer: Call;
let drive: Call;
let appInstall: Call;

beforeAll(async () => {
  const cds = await import("../src/routes/cloud-data-server-install");
  cloudDataServer = (body = {}) =>
    (cds.POST as unknown as (r: Request) => Promise<Response>)(
      jsonRequest("/api/cloud-data-server/install", { ...CREDS, ...body }),
    );

  const dr = await import("../src/routes/drive-install");
  drive = (body = {}) =>
    (dr.POST as unknown as (r: Request) => Promise<Response>)(
      jsonRequest("/api/drive/install", { ...CREDS, ...body }),
    );

  const app = await import("../src/routes/apps-cloud-install");
  appInstall = (body = {}) => {
    const appId = (body.appId as string) ?? "photos";
    return (
      app.POST as unknown as (
        r: Request,
        ctx: { params: Promise<{ appId: string }> },
      ) => Promise<Response>
    )(
      jsonRequest(`/api/apps/${appId}/cloud-install`, {
        ...CREDS,
        region: "us-east-2",
        ...body,
      }),
      { params: Promise.resolve({ appId }) },
    );
  };
});

beforeEach(() => {
  resetSpawns();
  writeConfig(FULL_CONFIG);
  // Each test starts with no run on disk.
  rmSync(join(dataDir, "installs"), { recursive: true, force: true });
});

afterEach(async () => {
  // A run left going would read as in progress to the next test — which is
  // the very thing the reattach path keys off.
  for (const child of spawnedChildren()) child.exit(0);
});

/** Drive the stream to completion so the route's module state is cleared. */
async function finish(res: Response, child: FakeChild, code = 0) {
  const stream = readSse(res);
  child.exit(code);
  return stream.rest();
}

describe("credentials are required before anything spawns", () => {
  it.each([
    ["cloud-data-server", () => cloudDataServer({ sessionToken: "" })],
    ["drive", () => drive({ sessionToken: "" })],
    ["an app", () => appInstall({ sessionToken: "" })],
  ])("%s answers 400 JSON, not an event stream", async (_label, call) => {
    const res = await call();
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(((await res.json()) as { error: string }).error).toContain("sessionToken");
    expect(spawnedChildren()).toHaveLength(0);
  });

  it("an app install also requires the region, which names the stack", async () => {
    const res = await appInstall({ region: "" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("region");
  });
});

describe("the cloud-data-server pass", () => {
  it("refuses before the wizard has written a config", async () => {
    rmSync(configPath, { force: true });
    const res = await cloudDataServer();
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("config.json not found");
  });

  it("refuses before the Stack outputs step, naming the step", async () => {
    writeConfig({ stackPrefix: "sktest" });
    const res = await cloudDataServer();
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("Stack outputs");
  });

  it("runs the installer CLI non-interactively, in the region the pool id implies", async () => {
    const res = await cloudDataServer();
    const child = lastChild();
    expect(child.command).toBe("pnpm");
    expect(child.args).toContain("cli:install-cloud-data-server");
    expect(child.args).toContain("--non-interactive");
    expect(child.options.env).toMatchObject({
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_REGION: "us-east-2",
    });
    await finish(res, child);
  });

  it("ends with the outputs the wizard needs, read back off the config the run wrote", async () => {
    const res = await cloudDataServer();
    const child = lastChild();
    const stream = readSse(res);
    child.say("Deploying…\n");
    // The installer rewrites the config before exiting; the route reads it
    // afterwards rather than parsing them out of the log.
    writeConfig({ ...FULL_CONFIG, s3Bucket: "sktest-files-new" });
    child.exit(0);
    const events = await stream.rest();
    const done = events.at(-1)!;
    expect(done.event).toBe("done");
    expect(JSON.parse(done.data)).toMatchObject({
      bucketName: "sktest-files-new",
      auroraHostname: FULL_CONFIG.auroraEndpoint,
      apiGatewayUrl: FULL_CONFIG.apiGatewayUrl,
      publicBaseUrl: FULL_CONFIG.publicBaseUrl,
      sessionAuthorizerId: FULL_CONFIG.sessionAuthorizerId,
    });
  });

  it("reports an error rather than a done when the outputs cannot be read back", async () => {
    // A run that succeeded and left an unreadable config is not a success the
    // wizard can act on: its next step needs those outputs.
    const res = await cloudDataServer();
    const child = lastChild();
    const stream = readSse(res);
    writeConfig("{ not json");
    child.exit(0);
    const events = await stream.rest();
    expect(events.at(-1)!.event).toBe("error");
    expect(JSON.parse(events.at(-1)!.data).message).toContain("reading outputs failed");
  });
});

describe("the Drive pass", () => {
  it("refuses until the cloud-data-server pass has left its outputs behind", async () => {
    writeConfig({ userPoolId: "us-east-2_abc123" });
    const res = await drive();
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "run the cloud-data-server install first",
    );
    expect(spawnedChildren()).toHaveLength(0);
  });

  it("runs the Drive installer and ends with a bare done", async () => {
    const res = await drive();
    const child = lastChild();
    expect(child.args).toContain("cli:install-drive");
    const events = await finish(res, child);
    expect(events.at(-1)).toEqual({ event: "done", data: "{}" });
  });
});

describe("an app install", () => {
  it("reads the app id from the path and passes it to the installer", async () => {
    // The id arrives as a promise of the route parameters. A router change
    // reshapes that argument, and nothing else would catch a mis-wire.
    const res = await appInstall({ appId: "memo" });
    const child = lastChild();
    expect(child.args).toEqual([
      "--filter",
      "@starkeep/admin-installer",
      "cli:install-app",
      "memo",
      "--non-interactive",
    ]);
    await finish(res, child);
  });

  it("names the app in its done event, so a client can tell two installs apart", async () => {
    const res = await appInstall({ appId: "memo" });
    const events = await finish(res, lastChild());
    expect(events.at(-1)!.event).toBe("done");
    expect(JSON.parse(events.at(-1)!.data)).toEqual({ appId: "memo" });
  });

  it.each([
    [["web"], ["--web"]],
    [["mobile"], ["--mobile"]],
    [
      ["web", "mobile"],
      ["--web", "--mobile"],
    ],
    [[], []],
  ])("passes surfaces %j to the installer as %j", async (surfaces, flags) => {
    const res = await appInstall({ appId: "photos", surfaces });
    const child = lastChild();
    expect(child.args.slice(5)).toEqual(flags);
    await finish(res, child);
  });

  it("passes no surface flag when the body names none, so the installer installs every surface", async () => {
    const res = await appInstall({ appId: "photos" });
    const child = lastChild();
    expect(
      child.args.filter((a) => a.startsWith("--") && a !== "--filter" && a !== "--non-interactive"),
    ).toEqual([]);
    await finish(res, child);
  });

  it("ignores a surface it does not know rather than passing it on", async () => {
    const res = await appInstall({ appId: "photos", surfaces: ["desktop", "mobile"] });
    const child = lastChild();
    expect(child.args.slice(5)).toEqual(["--mobile"]);
    await finish(res, child);
  });

  it("uses the region from the body rather than deriving one", async () => {
    const res = await appInstall({ region: "eu-west-1" });
    const child = lastChild();
    expect(child.options.env).toMatchObject({ AWS_REGION: "eu-west-1" });
    await finish(res, child);
  });
});

describe("line framing, which is where a long Pulumi log goes wrong", () => {
  it("reassembles a line split across two chunks into one frame", async () => {
    const res = await drive();
    const child = lastChild();
    const stream = readSse(res);
    child.say("Creating iam:Role sktest-");
    child.say("user-data-owner-role\n");
    child.exit(0);
    expect(lines(await stream.rest())).toEqual(["Creating iam:Role sktest-user-data-owner-role"]);
  });

  it("emits a trailing line with no newline when the child exits", async () => {
    // Pulumi's last line of output often arrives without one, and losing it
    // loses the reason a failed install failed.
    const res = await drive();
    const child = lastChild();
    const stream = readSse(res);
    child.say("error: the last thing that happened");
    child.exit(1);
    const events = await stream.rest();
    expect(lines(events)).toEqual(["error: the last thing that happened"]);
    expect(events.at(-1)!.event).toBe("error");
  });

  it("delivers many lines from one chunk in order", async () => {
    const res = await drive();
    const child = lastChild();
    const stream = readSse(res);
    child.say("one\ntwo\nthree\n");
    child.exit(0);
    expect(lines(await stream.rest())).toEqual(["one", "two", "three"]);
  });
});

describe("a rejected AWS session", () => {
  it.each([
    ["an expired STS token", "ExpiredTokenException: The security token is expired"],
    ["a DSQL refusal, which carries no SDK error", "unable to accept connection, access denied"],
  ])("ends with EXPIRED_TOKEN after %s", async (_label, line) => {
    // The wizard reads this code to send the operator back to the sign-in step
    // rather than showing a stack trace with no remedy in it.
    const res = await drive();
    const child = lastChild();
    const stream = readSse(res);
    child.sayErr(`${line}\n`);
    child.exit(1);
    const events = await stream.rest();
    expect(events.at(-1)!.event).toBe("error");
    expect(JSON.parse(events.at(-1)!.data)).toMatchObject({ code: "EXPIRED_TOKEN" });
  });

  it("reports an ordinary failure with no code, so the wizard offers a retry", async () => {
    const res = await drive();
    const child = lastChild();
    const stream = readSse(res);
    child.sayErr("error: resource already exists\n");
    child.exit(1);
    const events = await stream.rest();
    const payload = JSON.parse(events.at(-1)!.data) as { message: string; code?: string };
    expect(payload.code).toBeUndefined();
    expect(payload.message).toContain("exited with code 1");
  });

  it("reports a spawn failure as an error with the spawn's own message", async () => {
    const res = await drive();
    const child = lastChild();
    const stream = readSse(res);
    child.fail("spawn pnpm ENOENT");
    const events = await stream.rest();
    expect(events.at(-1)!.event).toBe("error");
    expect(JSON.parse(events.at(-1)!.data).message).toContain("ENOENT");
  });
});

describe("reattaching to a run in progress", () => {
  it("does not spawn a second installer when a POST arrives mid-run", async () => {
    // The backgrounded-tab case: the browser suspends, the SSE connection
    // drops, the child keeps going, and the page reconnects. A second Pulumi
    // run against one stack is what this prevents.
    const first = await drive();
    const child = lastChild();
    const firstStream = readSse(first);
    child.say("Creating resources…\n");

    const second = await drive();
    expect(spawnedChildren()).toHaveLength(1);

    const secondStream = readSse(second);
    expect(await secondStream.next()).toEqual({
      event: "message",
      data: '"[Reconnected to in-progress Drive install]"',
    });

    // Both connections see the child's output from here on, so a page that
    // reconnected shows the run's progress rather than a blank log.
    child.say("Still going…\n");
    expect(JSON.parse((await firstStream.next())!.data)).toBe("Creating resources…");
    expect(JSON.parse((await firstStream.next())!.data)).toBe("Still going…");
    expect(JSON.parse((await secondStream.next())!.data)).toBe("Still going…");

    child.exit(0);
    expect((await secondStream.rest()).at(-1)).toEqual({ event: "done", data: "{}" });
  });

  it("sends the terminal event to every connection following the run", async () => {
    // Each connection follows the run's log on its own, so the one a sleeping
    // browser left open ends cleanly too instead of hanging.
    const first = await drive();
    const child = lastChild();
    const firstStream = readSse(first);
    const second = await drive();
    const secondStream = readSse(second);
    await secondStream.next(); // the reconnect notice

    child.exit(0);
    expect((await secondStream.rest()).at(-1)!.event).toBe("done");
    expect((await firstStream.rest()).at(-1)!.event).toBe("done");
  });

  it("starts a fresh run with the new credentials when the one it reattached to fails", async () => {
    // The reconnecting POST carries fresh credentials. If the run it joined was
    // the one that failed on stale ones, retrying is the point of reconnecting.
    const first = await drive();
    const firstChild = lastChild();
    readSse(first);

    const second = await drive({ accessKeyId: "AKIA-FRESH" });
    const secondStream = readSse(second);
    expect(await secondStream.next()).toMatchObject({ event: "message" });

    firstChild.exit(1);
    // The follower sees the failure on its next look at the run.
    await vi.waitFor(() => expect(spawnedChildren()).toHaveLength(2));
    expect(lastChild().options.env).toMatchObject({ AWS_ACCESS_KEY_ID: "AKIA-FRESH" });
    expect(JSON.parse((await secondStream.next())!.data)).toContain("starting fresh");

    lastChild().say("Retrying…\n");
    lastChild().exit(0);
    const events = await secondStream.rest();
    expect(lines(events)).toContain("Retrying…");
    expect(events.at(-1)!.event).toBe("done");
  });

  it("forgets the finished run, so the next POST spawns rather than reattaching", async () => {
    const first = await drive();
    const firstChild = lastChild();
    const firstStream = readSse(first);
    firstChild.exit(0);
    expect((await firstStream.rest()).at(-1)!.event).toBe("done");

    resetSpawns();
    const second = await drive();
    expect(spawnedChildren()).toHaveLength(1);
    const stream = readSse(second);
    lastChild().say("Creating resources…\n");
    // No reconnect notice: this is a new run, and its log starts at its own
    // first line.
    expect(JSON.parse((await stream.next())!.data)).toBe("Creating resources…");
    lastChild().exit(0);
    await stream.rest();
  });
});

describe("a run that outlives admin-web", () => {
  /** A fresh copy of a route module, as a restarted admin-web loads it. */
  async function restartedDrive(body: Record<string, unknown> = {}): Promise<Response> {
    vi.resetModules();
    const fresh = await import("../src/routes/drive-install");
    return (fresh.POST as unknown as (r: Request) => Promise<Response>)(
      jsonRequest("/api/drive/install", { ...CREDS, ...body }),
    );
  }

  it("starts the installer detached, so a restart of admin-web does not end it", async () => {
    const res = await drive();
    expect(lastChild().options.detached).toBe(true);
    await finish(res, lastChild());
  });

  it("is followed by a restarted admin-web, which starts no second installer", async () => {
    const first = await drive();
    const child = lastChild();
    const firstStream = readSse(first);
    child.say("Building protocol-primitives…\n");
    const seen = (await firstStream.next())!;
    expect(seen.id).toMatch(/^[0-9a-f]+:\d+$/);

    // The browser's stream dropped with the old process. The installer wrote
    // on while admin-web restarted, then the browser reconnects.
    child.say("Policy changed — waiting 60s for IAM propagation\n");
    const again = await restartedDrive({ reattach: true, resumeFrom: seen.id });
    const stream = readSse(again);
    expect(spawnedChildren()).toHaveLength(1);
    expect(JSON.parse((await stream.next())!.data)).toBe(
      "[Reconnected to in-progress Drive install]",
    );

    child.say("Deploying…\n");
    child.exit(0);
    const events = await stream.rest();
    // The line from the restart's gap arrives, and nothing the browser already had.
    expect(lines(events)).toEqual([
      "Policy changed — waiting 60s for IAM propagation",
      "Deploying…",
    ]);
    expect(events.at(-1)).toEqual({ event: "done", data: "{}" });
  });

  it("delivers the lines a finished run wrote while the browser was away, then the outcome", async () => {
    const first = await drive();
    const child = lastChild();
    const firstStream = readSse(first);
    child.say("one\n");
    const seen = (await firstStream.next())!;
    child.say("two\nthree\n");
    child.exit(0);

    const events = await readSse(
      await restartedDrive({ reattach: true, resumeFrom: seen.id }),
    ).rest();
    expect(lines(events)).toEqual(["[The Drive install ended while disconnected]", "two", "three"]);
    expect(events.at(-1)).toEqual({ event: "done", data: "{}" });
  });

  it("replays a run from its start for a browser whose last line came from another run", async () => {
    const first = await drive();
    const firstStream = readSse(first);
    lastChild().say("old run\n");
    const stale = (await firstStream.next())!;
    lastChild().exit(1);
    await firstStream.rest();

    const second = await drive();
    readSse(second);
    lastChild().say("new run\n");
    const again = readSse(await restartedDrive({ reattach: true, resumeFrom: stale.id }));
    lastChild().exit(0);
    const events = await again.rest();
    expect(lines(events)).toEqual(["[Reconnected to in-progress Drive install]", "new run"]);
  });

  it("reports how the run ended when the browser reconnects after it finished", async () => {
    const first = await drive();
    const child = lastChild();
    const firstStream = readSse(first);
    child.exit(0);
    await firstStream.rest();

    const again = await restartedDrive({ reattach: true });
    const events = await readSse(again).rest();
    expect(spawnedChildren()).toHaveLength(1);
    expect(lines(events)).toEqual(["[The Drive install ended while disconnected]"]);
    expect(events.at(-1)).toEqual({ event: "done", data: "{}" });
    // A restarted admin-web's spawns land in the same registry, so the counts
    // above would have caught a second installer.
    await restartedDrive();
    expect(spawnedChildren()).toHaveLength(2);
  });

  it("reports an expired session that ended the run while the browser was away", async () => {
    const first = await drive();
    const child = lastChild();
    const firstStream = readSse(first);
    child.sayErr("ExpiredTokenException: The security token is expired\n");
    child.exit(1);
    await firstStream.rest();

    const events = await readSse(await restartedDrive({ reattach: true })).rest();
    expect(JSON.parse(events.at(-1)!.data)).toMatchObject({ code: "EXPIRED_TOKEN" });
    expect(spawnedChildren()).toHaveLength(1);
  });

  it("refuses to reconnect when no run ever started, and starts none", async () => {
    const events = await readSse(await drive({ reattach: true })).rest();
    expect(events.at(-1)!.event).toBe("error");
    expect(JSON.parse(events.at(-1)!.data).message).toContain("No Drive install to reconnect to");
    expect(spawnedChildren()).toHaveLength(0);
  });

  it("ends with an error when the run's process died without recording an exit code", async () => {
    const res = await drive();
    const events = await finish(res, lastChild(), null as unknown as number);
    expect(events.at(-1)!.event).toBe("error");
    expect(JSON.parse(events.at(-1)!.data).message).toContain("exited with code null");
  });

  it("keeps the AWS credentials off the disk", async () => {
    const res = await cloudDataServer();
    lastChild().say("Deploying…\n");
    await finish(res, lastChild());
    const dir = join(dataDir, "installs", "cloud-data-server");
    for (const name of readdirSync(dir)) {
      const text = readFileSync(join(dir, name), "utf8");
      expect(text, name).not.toContain(CREDS.secretAccessKey);
      expect(text, name).not.toContain(CREDS.sessionToken);
    }
  });
});
