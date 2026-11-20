/**
 * The one shape every operation reports progress in, and the line format that
 * carries it out of the process that runs the operation.
 *
 * The CLI renders these events as status lines, or as one JSON object per line
 * under `--json`. admin-web maps them onto its server-sent events.
 *
 * An operation runs in a child process whose standard output is also where
 * Pulumi, an app's bundle command and a dependency install write. So the
 * runner writes each event as one line that starts with {@link EVENT_PREFIX},
 * and a reader turns every line without the prefix into a `log` event. The
 * run's single log file stays the whole record, so a reader that attaches
 * late replays it and sees the same events.
 */

export type OperationEvent =
  | { type: "progress"; message: string }
  | { type: "log"; line: string }
  | { type: "prompt-needed"; reason: "consent" | "sign-in" | "confirm"; detail: string }
  | {
      type: "result";
      ok: boolean;
      data?: unknown;
      error?: { message: string; code?: string; logPath?: string };
    };

export type Emit = (event: OperationEvent) => void;

/** An `emit` that drops every event, for a caller that wants only the result. */
export const silent: Emit = () => {};

/** What starts a line that carries an event. */
export const EVENT_PREFIX = "@@starkeep-event ";

/** One event as a line, without its newline. */
export function encodeEventLine(event: OperationEvent): string {
  return `${EVENT_PREFIX}${JSON.stringify(event)}`;
}

function isEvent(value: unknown): value is OperationEvent {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case "progress":
      return typeof v.message === "string";
    case "log":
      return typeof v.line === "string";
    case "prompt-needed":
      return typeof v.detail === "string" && typeof v.reason === "string";
    case "result":
      return typeof v.ok === "boolean";
    default:
      return false;
  }
}

/**
 * The event a line of a run's output carries. A line without the prefix, or
 * with a prefix and no valid event after it, is a `log` line.
 */
export function parseEventLine(line: string): OperationEvent {
  if (line.startsWith(EVENT_PREFIX)) {
    try {
      const parsed: unknown = JSON.parse(line.slice(EVENT_PREFIX.length));
      if (isEvent(parsed)) return parsed;
    } catch {
      // Not an event after all: keep the line as it was written.
    }
  }
  return { type: "log", line };
}
