/**
 * The event stream the three install routes answer with: the cloud data
 * server, Drive and a cloud app.
 *
 * The installer runs detached (see `detached-run.ts`), so this stream is only a
 * view of the run. A connection that drops leaves the run going, and so does
 * an admin-web restart. The next POST finds the run on disk and follows it.
 *
 * Response: text/event-stream
 *   id:    <run id>:<byte offset past the line>   (on installer lines only)
 *   data:  <a line of the installer's output>
 *   event: done   data: <the route's own payload>
 *   event: error  data: { message: string, code?: string }
 *
 * The routes start installer operations through `run-operation`
 * (`@starkeep/admin-installer/operations`), whose output carries structured
 * events. A `progress` or `prompt-needed` event reaches the browser as an
 * ordinary line, a `log` event as the line it carried, and the `result` event
 * decides the terminal event: its error code names the remedy. An operation
 * that failed on the admin's credentials ends with `code: "EXPIRED_TOKEN"`,
 * which sends the person back to sign in. A run that wrote no result, such as
 * the dependency install or a crashed operation, falls back to its exit code.
 *
 * A POST mid-run follows the run instead of starting a second installer on the
 * same stack. When that run then fails, the POST starts a fresh one with its
 * own credentials, because a run that failed on stale credentials is the usual
 * reason to post again. A slot that runs more than one kind of install names
 * each run's `owner`. A POST mid-run for another owner gets a 409 instead,
 * because following the run would show one install's output as another's. A POST with `reattach: true` comes from a browser
 * reconnecting after the stream dropped. Such a POST never starts a run: it
 * follows the run in progress, or reports how the last one ended.
 *
 * A reconnecting browser sends the last `id` it received as `resumeFrom`. The
 * stream then resumes just past that line, so the lines the installer wrote
 * while the browser was away still reach it. An admin-web restart takes a few
 * seconds, and the lines from those seconds can be the ones that explain a long
 * quiet wait after them. A `resumeFrom` from another run, or none, replays the
 * run from its start: the browser has seen none of it.
 */

import { copyFileSync, readFileSync } from "node:fs";
import { parseEventLine, type OperationEvent } from "@starkeep/operator/events";
import { followRun, runLogPath, runStatus, startRun } from "@starkeep/operator/runs";

export interface InstallStreamOptions {
  /** The run slot. One run at a time per slot. */
  readonly key: string;
  /**
   * What this POST installs, for a slot shared by several installs, such as
   * "photos (web)". A POST mid-run for another owner gets a 409.
   */
  readonly owner?: string;
  /** What the run is called in progress notices: "install", "Drive install", "deploy". */
  readonly noun: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Whether this POST only reconnects to a run, and must not start one. */
  readonly reattach: boolean;
  /** The last `id` a reconnecting browser received, as `<run id>:<offset>`. */
  readonly resumeFrom?: string;
  /** The terminal event for a run that exited 0. */
  readonly onSuccess: () => { event: "done" | "error"; data: unknown };
  /** The error message for a run that exited with another code. */
  readonly failureMessage: (code: number | null) => string;
  /** A path to copy the run's full output to when it ends, for the IAM trace capture. */
  readonly copyLogTo?: string;
}

function logLines(key: string): string[] {
  try {
    return readFileSync(runLogPath(key), "utf8").split("\n");
  } catch {
    return [];
  }
}

/** Where `resumeFrom` points in the run `runId`, or the run's start. */
function resumeOffset(resumeFrom: string | undefined, runId: string): number {
  const match = /^([0-9a-f]+):(\d+)$/.exec(resumeFrom ?? "");
  return match && match[1] === runId ? Number(match[2]) : 0;
}

const EXPIRED = {
  message: "Your AWS sign-in session was rejected (expired or invalid). Sign in again to retry.",
  code: "EXPIRED_TOKEN",
};

type ResultEvent = Extract<OperationEvent, { type: "result" }>;

/** The last `result` event in a run's log, for a run that ended while no one followed it. */
function lastResult(key: string): ResultEvent | null {
  let result: ResultEvent | null = null;
  for (const line of logLines(key)) {
    const event = parseEventLine(line);
    if (event.type === "result") result = event;
  }
  return result;
}

/** The terminal error for a failed operation's result. */
function errorForResult(result: ResultEvent): { message: string; code?: string } {
  const code = result.error?.code;
  // A sign-in that ended mid-run has the same remedy as an expired one.
  if (code === "CREDENTIALS_EXPIRED" || code === "NOT_SIGNED_IN") return EXPIRED;
  return {
    message: result.error?.message ?? "The operation failed.",
    ...(code ? { code } : {}),
  };
}

export function installStream(options: InstallStreamOptions): Response {
  if (options.owner !== undefined) {
    const current = runStatus(options.key);
    if (current.state === "running" && current.owner !== options.owner) {
      return Response.json(
        {
          error: `Another cloud install is running (${current.owner ?? "unknown"}). Try again once it ends.`,
        },
        { status: 409 },
      );
    }
  }

  const encoder = new TextEncoder();
  let stop: () => void = () => {};

  const stream = new ReadableStream({
    start(controller) {
      let result: ResultEvent | null = null;
      let closed = false;

      const send = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // The connection closed under us.
        }
      };
      const emit = (line: string, id?: string) =>
        send(`${id ? `id: ${id}\n` : ""}data: ${JSON.stringify(line)}\n\n`);
      const emitEvent = (event: string, data: unknown) =>
        send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const close = () => {
        stop();
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      const lineSender = (runId: string) => (line: string, offset: number) => {
        const id = runId ? `${runId}:${offset}` : undefined;
        const event = parseEventLine(line);
        switch (event.type) {
          case "log":
            emit(event.line, id);
            return;
          case "progress":
          case "prompt-needed": {
            const text = event.type === "progress" ? event.message : event.detail;
            const parts = text.split("\n");
            parts.forEach((part, i) => emit(part, i === parts.length - 1 ? id : undefined));
            return;
          }
          case "result":
            result = event;
            return;
        }
      };

      const finish = (code: number | null) => {
        if (options.copyLogTo) {
          try {
            copyFileSync(runLogPath(options.key), options.copyLogTo);
          } catch (err) {
            console.warn(`[install] could not copy the log to ${options.copyLogTo}: ${err}`);
          }
        }
        if (result ? result.ok : code === 0) {
          const terminal = options.onSuccess();
          emitEvent(terminal.event, terminal.data);
        } else if (result) {
          emitEvent("error", errorForResult(result));
        } else {
          emitEvent("error", { message: options.failureMessage(code) });
        }
        close();
      };

      const follow = (from: number | "end", onEnd: (code: number | null) => void) => {
        const current = runStatus(options.key);
        const runId = current.state === "none" ? "" : current.runId;
        stop = followRun(options.key, { from, onLine: lineSender(runId), onEnd });
      };

      const begin = () => {
        const child = startRun(options.key, options.command, options.args, {
          cwd: options.cwd,
          env: options.env,
          ...(options.owner !== undefined ? { owner: options.owner } : {}),
        });
        child.on("error", (err) => {
          emitEvent("error", { message: err.message });
          close();
        });
        follow(0, finish);
      };

      const status = runStatus(options.key);

      if (options.reattach) {
        if (status.state === "none") {
          emitEvent("error", { message: `No ${options.noun} to reconnect to` });
          close();
          return;
        }
        emit(
          status.state === "running"
            ? `[Reconnected to in-progress ${options.noun}]`
            : `[The ${options.noun} ended while disconnected]`,
        );
        // The lines before the resume point went to the browser on the
        // dropped stream. They are read, not replayed, for a result the run
        // already wrote.
        result = lastResult(options.key);
        follow(resumeOffset(options.resumeFrom, status.runId), finish);
        return;
      }

      if (status.state === "running") {
        emit(`[Reconnected to in-progress ${options.noun}]`);
        follow("end", (code) => {
          if (result ? result.ok : code === 0) {
            finish(code);
            return;
          }
          emit(`[Previous run ended — starting fresh ${options.noun}...]`);
          result = null;
          // Another connection that followed the same run may have started
          // the fresh one already. Follow that one rather than start a second.
          if (runStatus(options.key).state === "running") follow(0, finish);
          else begin();
        });
        return;
      }

      begin();
    },

    cancel() {
      // The browser went away. The run goes on; only this view of it stops.
      stop();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
