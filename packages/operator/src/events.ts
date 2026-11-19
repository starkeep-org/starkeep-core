/**
 * The one shape every operation reports progress in. The CLI renders these
 * events as status lines, or as one JSON object per line under `--json`.
 * admin-web maps them onto its server-sent events.
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
