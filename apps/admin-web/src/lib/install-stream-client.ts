/**
 * The browser's side of an install stream (see `install-stream.ts`).
 *
 * The installer runs detached on the server, so a stream that drops — admin-web
 * restarting under `tsx watch`, say — has not ended the run. This reader then
 * reconnects with `reattach: true`, which follows the run in progress or reports
 * how it ended, and never starts a second one. The reconnect carries the last
 * line `id` the reader received as `resumeFrom`, so the output resumes where
 * the dropped stream left off.
 */

export type InstallOutcome =
  | { kind: "done"; data: string }
  | { kind: "error"; message: string; tokenExpired: boolean };

export interface InstallStreamClientOptions {
  /** Each line of the installer's output, and the reader's own notices. */
  readonly onLine: (line: string) => void;
  /** True once the caller no longer wants the outcome. */
  readonly isAborted?: () => boolean;
  /** How many times to reconnect after a dropped stream. */
  readonly reconnects?: number;
  /** The wait before each reconnect, long enough for admin-web to restart. */
  readonly reconnectDelayMs?: number;
  readonly fetchImpl?: typeof fetch;
}

type ReadResult = InstallOutcome | { kind: "dropped" };

async function readStream(
  resp: Response,
  onLine: (line: string) => void,
  onId: (id: string) => void,
  isAborted: () => boolean,
): Promise<ReadResult> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || isAborted()) return { kind: "dropped" };
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        let eventType = "message";
        let data = "";
        let id: string | null = null;
        for (const part of chunk.split("\n")) {
          if (part.startsWith("event: ")) eventType = part.slice(7);
          else if (part.startsWith("data: ")) data = part.slice(6);
          else if (part.startsWith("id: ")) id = part.slice(4);
        }
        if (eventType === "done") return { kind: "done", data };
        if (eventType === "error") return errorFrom(data);
        if (data) {
          try {
            onLine(JSON.parse(data) as string);
          } catch {
            onLine(data);
          }
        }
        if (id !== null) onId(id);
      }
    }
  } catch {
    // The connection broke mid-read.
    return { kind: "dropped" };
  }
}

/** The server's `{ message, code? }` error payload, or an older bare string. */
function errorFrom(data: string): InstallOutcome {
  let message = data;
  let code: string | undefined;
  try {
    const parsed = JSON.parse(data) as unknown;
    if (typeof parsed === "string") {
      message = parsed;
    } else if (parsed && typeof parsed === "object") {
      const p = parsed as { message?: unknown; code?: unknown };
      if (typeof p.message === "string") message = p.message;
      if (typeof p.code === "string") code = p.code;
    }
  } catch {
    // Not JSON: keep the text as it came.
  }
  return { kind: "error", message, tokenExpired: code === "EXPIRED_TOKEN" };
}

async function errorFromResponse(resp: Response): Promise<InstallOutcome> {
  let message = `${resp.status} ${resp.statusText}`;
  try {
    const j = (await resp.json()) as { error?: string };
    if (j.error) message = j.error;
  } catch {
    // Not JSON.
  }
  return { kind: "error", message, tokenExpired: false };
}

/**
 * POST an install and read its stream to the end, reconnecting when the
 * stream drops before a `done` or `error`.
 */
export async function runInstallStream(
  url: string,
  body: Record<string, unknown>,
  options: InstallStreamClientOptions,
): Promise<InstallOutcome> {
  const doFetch = options.fetchImpl ?? fetch;
  const isAborted = options.isAborted ?? (() => false);
  const reconnects = options.reconnects ?? 20;
  const delayMs = options.reconnectDelayMs ?? 1500;
  // The last line id received, on any of the streams so far.
  let resumeFrom: string | null = null;

  for (let attempt = 0; ; attempt++) {
    const reattach = attempt > 0;
    let resp: Response | null = null;
    try {
      resp = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          reattach
            ? { ...body, reattach: true, ...(resumeFrom !== null ? { resumeFrom } : {}) }
            : body,
        ),
      });
    } catch {
      // admin-web is not answering yet. Counts as a dropped stream.
    }
    if (isAborted()) return { kind: "error", message: "Cancelled", tokenExpired: false };
    if (resp && (!resp.ok || !resp.body)) return errorFromResponse(resp);
    const result: ReadResult = resp
      ? await readStream(resp, options.onLine, (id) => (resumeFrom = id), isAborted)
      : { kind: "dropped" };
    if (result.kind !== "dropped") return result;
    if (isAborted()) return { kind: "error", message: "Cancelled", tokenExpired: false };
    if (attempt >= reconnects) {
      return {
        kind: "error",
        message: "Lost the connection to admin-web during the install",
        tokenExpired: false,
      };
    }
    // Said once per dropped stream, not once per failed reconnect.
    if (resp)
      options.onLine(
        "[Lost the connection to admin-web — the install keeps running. Reconnecting…]",
      );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
