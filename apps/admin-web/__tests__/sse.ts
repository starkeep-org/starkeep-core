/**
 * Reading a `text/event-stream` response the way the browser does.
 *
 * The wizard's own reader splits on a blank line and then reads `event:` and
 * `data:` off each chunk (see `Step5Deploy`'s `runPass`). This reader matches
 * it, so a framing change that would break the wizard breaks these tests.
 */

export interface SseEvent {
  /** `message` for a bare `data:` frame, matching the EventSource default. */
  event: string;
  /** The raw `data:` payload, before JSON parsing. */
  data: string;
}

export interface SseStream {
  /** The next frame, or null once the server closed the stream. */
  next(): Promise<SseEvent | null>;
  /** Every remaining frame, read until the stream closes. */
  rest(): Promise<SseEvent[]>;
}

export function readSse(res: Response): SseStream {
  if (!res.body) throw new Error(`response carries no body (status ${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pending: SseEvent[] = [];
  let closed = false;

  function drain(): void {
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      if (!chunk) continue;
      let event = "message";
      let data = "";
      for (const part of chunk.split("\n")) {
        if (part.startsWith("event: ")) event = part.slice(7);
        else if (part.startsWith("data: ")) data = part.slice(6);
      }
      pending.push({ event, data });
    }
  }

  async function next(): Promise<SseEvent | null> {
    for (;;) {
      if (pending.length > 0) return pending.shift()!;
      if (closed) return null;
      const { done, value } = await reader.read();
      if (done) {
        closed = true;
        continue;
      }
      buffer += decoder.decode(value, { stream: true });
      drain();
    }
  }

  return {
    next,
    async rest() {
      const all: SseEvent[] = [];
      for (;;) {
        const event = await next();
        if (!event) return all;
        all.push(event);
      }
    },
  };
}

/** The `data:` payloads of every bare `data:` frame, JSON-decoded. */
export function lines(events: SseEvent[]): string[] {
  return events.filter((e) => e.event === "message").map((e) => JSON.parse(e.data) as string);
}
