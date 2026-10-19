/**
 * The browser's install-stream reader: what it does when admin-web drops the
 * stream mid-run, as a restart under `tsx watch` does.
 */
import { describe, expect, it } from "vitest";
import { runInstallStream } from "../src/lib/install-stream-client";

/** An event-stream response whose body ends after `frames`. */
function streamOf(...frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

const line = (text: string) => `data: ${JSON.stringify(text)}\n\n`;
const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

/** A fetch that answers each call with the next response, and records the bodies it was sent. */
function scripted(...answers: Array<Response | Error>) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetchImpl, bodies };
}

describe("runInstallStream", () => {
  it("returns the done payload and passes every line on", async () => {
    const { fetchImpl } = scripted(streamOf(line("one"), line("two"), event("done", { appId: "memo" })));
    const seen: string[] = [];
    const outcome = await runInstallStream("/api/x", { a: 1 }, { onLine: (l) => seen.push(l), fetchImpl });
    expect(outcome).toEqual({ kind: "done", data: JSON.stringify({ appId: "memo" }) });
    expect(seen).toEqual(["one", "two"]);
  });

  it("reconnects with reattach after the stream drops, and finishes on the reconnected stream", async () => {
    const { fetchImpl, bodies } = scripted(
      streamOf(line("Building…")),
      new TypeError("Failed to fetch"),
      streamOf(line("[Reconnected to in-progress install]"), line("Deploying…"), event("done", {})),
    );
    const seen: string[] = [];
    const outcome = await runInstallStream("/api/x", { accessKeyId: "AKIA" }, {
      onLine: (l) => seen.push(l),
      fetchImpl,
      reconnectDelayMs: 0,
    });
    expect(outcome.kind).toBe("done");
    expect(bodies).toEqual([
      { accessKeyId: "AKIA" },
      { accessKeyId: "AKIA", reattach: true },
      { accessKeyId: "AKIA", reattach: true },
    ]);
    // One notice for the one dropped stream, not one per failed attempt.
    expect(seen.filter((l) => l.startsWith("[Lost the connection"))).toHaveLength(1);
    expect(seen.at(-1)).toBe("Deploying…");
  });

  it("resumes from the last line id it received, across reconnects that carry none", async () => {
    const { fetchImpl, bodies } = scripted(
      streamOf(`id: abc:10\n${line("one")}`, `id: abc:20\n${line("two")}`),
      streamOf(line("[Reconnected to in-progress install]")),
      streamOf(event("done", {})),
    );
    await runInstallStream("/api/x", {}, { onLine: () => {}, fetchImpl, reconnectDelayMs: 0 });
    expect(bodies).toEqual([{}, { reattach: true, resumeFrom: "abc:20" }, { reattach: true, resumeFrom: "abc:20" }]);
  });

  it("reads the expired-session code off an error event", async () => {
    const { fetchImpl } = scripted(streamOf(event("error", { message: "rejected", code: "EXPIRED_TOKEN" })));
    const outcome = await runInstallStream("/api/x", {}, { onLine: () => {}, fetchImpl });
    expect(outcome).toEqual({ kind: "error", message: "rejected", tokenExpired: true });
  });

  it("answers a refused request with the server's message, without reconnecting", async () => {
    const { fetchImpl, bodies } = scripted(
      new Response(JSON.stringify({ error: "config.json not found" }), { status: 400 }),
    );
    const outcome = await runInstallStream("/api/x", {}, { onLine: () => {}, fetchImpl, reconnectDelayMs: 0 });
    expect(outcome).toEqual({ kind: "error", message: "config.json not found", tokenExpired: false });
    expect(bodies).toHaveLength(1);
  });

  it("gives up after its reconnects run out", async () => {
    const { fetchImpl, bodies } = scripted(streamOf(), new TypeError("down"), new TypeError("down"));
    const outcome = await runInstallStream("/api/x", {}, {
      onLine: () => {},
      fetchImpl,
      reconnects: 2,
      reconnectDelayMs: 0,
    });
    expect(outcome.kind).toBe("error");
    expect(bodies).toHaveLength(3);
  });

  it("stops without reconnecting once the caller aborts", async () => {
    let aborted = false;
    const { fetchImpl, bodies } = scripted(streamOf(line("one")));
    const outcome = await runInstallStream("/api/x", {}, {
      onLine: () => {
        aborted = true;
      },
      isAborted: () => aborted,
      fetchImpl,
      reconnectDelayMs: 0,
    });
    expect(outcome.kind).toBe("error");
    expect(bodies).toHaveLength(1);
  });
});
