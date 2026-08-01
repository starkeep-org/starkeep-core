/**
 * Parse an HTTP `Range` header into an inclusive byte range.
 *
 * Returns `null` for "no range, serve the whole thing" — which covers a header
 * this server chooses not to honour as well as an absent one. Falling back to
 * the full object is always a correct response (200 with everything is what a
 * server without range support does), whereas guessing at a malformed range
 * would serve the wrong bytes under a status code that claims they are right.
 *
 * Only single ranges are honoured. Multi-range requests are legal and require a
 * `multipart/byteranges` body; no video element sends them, and answering 200
 * with the whole object is the spec-sanctioned response for a server that does
 * not support them.
 */
export function parseRangeHeader(
  header: string | string[] | undefined,
  size: number,
): { start: number; end?: number } | null | "unsatisfiable" {
  if (typeof header !== "string") return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  // `bytes=-500` means the *last* 500 bytes, not "from 0 to 500". Reading it as
  // the latter is the classic mistake here, and it does not fail loudly — it
  // returns plausible bytes from the wrong end of the file, so a video plays
  // its opening frames when asked for its closing ones.
  if (rawStart === "") {
    if (rawEnd === "") return null; // `bytes=-` is meaningless.
    const suffixLength = Number(rawEnd);
    if (suffixLength === 0) return "unsatisfiable";
    // A suffix longer than the file is satisfiable and means the whole file,
    // per RFC 7233 — not an error.
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(rawStart);
  // An empty end is the open-ended form (`bytes=0-`), which is exactly what a
  // <video> element opens with — the common case, not an edge case.
  if (rawEnd === "") {
    return start >= size ? "unsatisfiable" : { start };
  }

  const end = Number(rawEnd);
  if (start > end) return null;
  if (start >= size) return "unsatisfiable";
  // Clamping the end is required rather than optional: browsers routinely ask
  // for a fixed-size chunk that overruns the last byte of the file, and a
  // literal read would either error or return a short body contradicting the
  // Content-Length this produces.
  return { start, end: Math.min(end, size - 1) };
}
