import type { IncomingMessage, ServerResponse } from "node:http";
import type { HLCClock } from "@starkeep/protocol-primitives";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";
import { createInProcessSyncTransport } from "./in-process-transport.js";
import {
  sanitizeExchangeRequest,
  InvalidExchangeRequest,
} from "../exchange-request.js";
import type { SyncExchangeRequest, SyncTransport } from "../types.js";

export interface HttpSyncServerOptions {
  readonly databaseAdapter: DatabaseAdapter;
  readonly objectStorageAdapter: ObjectStorageAdapter;
  readonly clock: HLCClock;
  /**
   * Optional transport override — if provided, takes precedence over the
   * default in-process transport.
   */
  readonly transport?: SyncTransport;
  /**
   * Body caps, in bytes. Default to the two constants below.
   *
   * Overridable because the file cap is 2 GB and a test that wanted to see the
   * refusal would otherwise have to push two gigabytes through a socket — so
   * the one route where unbounded buffering actually costs something was the
   * one route whose cap nothing checked. A server embedding this handler behind
   * a smaller upstream limit has the same reason to lower them.
   */
  readonly maxExchangeBodyBytes?: number;
  readonly maxFileBodyBytes?: number;
}

/**
 * Largest exchange body this server will read.
 *
 * A round's payload is bounded by the requester's own item cap and byte budget,
 * and rows carry no blobs — the bytes go through `/files/:key`, not through
 * here — so a real request is orders of magnitude under this. The cap exists
 * because `readBinary` otherwise buffers whatever arrives into memory with no
 * bound at all, and a peer on a broken build (or a truncated body that never
 * ends) takes the process down rather than getting an error.
 */
const MAX_EXCHANGE_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Largest object body accepted on `PUT /files/:key`.
 *
 * Deliberately far larger than the exchange cap: this is where a video actually
 * crosses the wire, and refusing a big one would stall its channel forever —
 * the same reasoning that lets a single oversized item ship alone in a round.
 * It is a backstop against unbounded buffering, not a policy on file size.
 */
const MAX_FILE_BODY_BYTES = 2 * 1024 * 1024 * 1024;

/** A body that exceeded its cap. Mapped to 413 rather than 400 or 500. */
class BodyTooLarge extends Error {
  constructor(readonly limit: number) {
    super(`request body exceeds ${limit} bytes`);
    this.name = "BodyTooLarge";
  }
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

/**
 * Request handler that recognizes the Starkeep sync + file routes.
 * Returns `true` if the request was handled; callers can compose this with
 * their own routing layer.
 */
export function createHttpSyncHandler(
  options: HttpSyncServerOptions,
): Handler {
  const transport =
    options.transport ??
    createInProcessSyncTransport({
      databaseAdapter: options.databaseAdapter,
      clock: options.clock,
      objectStorage: options.objectStorageAdapter,
    });
  const maxExchangeBody = options.maxExchangeBodyBytes ?? MAX_EXCHANGE_BODY_BYTES;
  const maxFileBody = options.maxFileBodyBytes ?? MAX_FILE_BODY_BYTES;

  return async (req, res) => {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host ?? "localhost"}`,
    );

    if (req.method === "POST" && url.pathname === "/sync/exchange") {
      // Checked, not cast: the parsed body is whatever the peer sent, and its
      // numbers reach a `LIMIT ?` and a `substr(…, 1, N)` a few frames down.
      let body: SyncExchangeRequest;
      try {
        body = sanitizeExchangeRequest(
          await readJson<unknown>(req, maxExchangeBody),
        );
      } catch (err) {
        if (err instanceof InvalidExchangeRequest) {
          sendJson(res, 400, { error: err.message });
          return true;
        }
        // A body that is not JSON is the caller's mistake, not this server's,
        // and it used to escape as a 500 — the same request the cloud handler
        // answers with a 400. Two behaviours on one route depending on which
        // side you hit is worse than either behaviour.
        if (err instanceof SyntaxError) {
          sendJson(res, 400, { error: "Body is not valid JSON" });
          return true;
        }
        if (err instanceof BodyTooLarge) {
          refuseTooLarge(req, res, err);
          return true;
        }
        throw err;
      }
      const response = await transport.exchange(body);
      sendJson(res, 200, response);
      return true;
    }

    // Checked before the general /files/:key route, whose (.+) would otherwise
    // swallow the trailing /stat segment as part of the key.
    const fileStatMatch = url.pathname.match(/^\/files\/(.+)\/stat$/);
    if (fileStatMatch && req.method === "GET") {
      const key = decodeURIComponent(fileStatMatch[1]!);
      const facts = await options.objectStorageAdapter.stat(key);
      if (!facts) {
        res.writeHead(404);
        res.end();
        return true;
      }
      sendJson(res, 200, facts);
      return true;
    }

    const fileMatch = url.pathname.match(/^\/files\/(.+)$/);
    if (fileMatch) {
      const key = decodeURIComponent(fileMatch[1]!);
      const storage = options.objectStorageAdapter;

      if (req.method === "HEAD") {
        const exists = await storage.has(key);
        res.writeHead(exists ? 200 : 404);
        res.end();
        return true;
      }
      if (req.method === "GET") {
        const file = await storage.get(key);
        if (!file) {
          res.writeHead(404);
          res.end();
          return true;
        }
        res.writeHead(200, {
          "Content-Type": file.contentType ?? "application/octet-stream",
          "Content-Length": String(file.size),
        });
        res.end(Buffer.from(file.data));
        return true;
      }
      if (req.method === "PUT") {
        let bytes: Buffer;
        try {
          bytes = await readBinary(req, maxFileBody);
        } catch (err) {
          if (err instanceof BodyTooLarge) {
            refuseTooLarge(req, res, err);
            return true;
          }
          throw err;
        }
        const contentType = req.headers["content-type"];
        await storage.put(key, bytes, {
          contentType:
            typeof contentType === "string" ? contentType : undefined,
        });
        res.writeHead(200);
        res.end();
        return true;
      }
      if (req.method === "DELETE") {
        await storage.delete(key);
        res.writeHead(204);
        res.end();
        return true;
      }
    }

    return false;
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson<T>(req: IncomingMessage, limit: number): Promise<T> {
  const buf = await readBinary(req, limit);
  // A `SyntaxError` from here is the caller's, and every call site maps it to a
  // 400. Not caught here because "this is not JSON" and "this is JSON that says
  // the wrong thing" deserve the same status and different messages.
  return JSON.parse(buf.toString("utf-8")) as T;
}

/**
 * Answer an oversized body with a 413, then stop the upload.
 *
 * The order is the point. `readBinary` used to destroy the socket the instant
 * it saw the limit crossed, which raced the response out of existence: the
 * sender usually saw the connection vanish and never learned *why* it was
 * refused — a peer on a broken build got "socket hang up" for a condition the
 * server understood exactly. It also made the refusal untestable, since a test
 * could only assert "413 or nothing".
 *
 * Nothing is buffered past the limit either way, so waiting for the response to
 * flush before destroying costs a small, bounded window of discarded bytes and
 * buys a client that can read its own error.
 */
function refuseTooLarge(
  req: IncomingMessage,
  res: ServerResponse,
  err: BodyTooLarge,
): void {
  res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
  res.end(JSON.stringify({ error: err.message }), () => {
    // Now the sender can stop: leaving the socket open means it keeps pushing
    // bytes at a request that has already been answered.
    req.destroy();
  });
}

/**
 * Read a request body into memory, refusing one over `limit`.
 *
 * Counted as it arrives rather than trusted from `Content-Length`, which a
 * caller controls and a chunked request omits entirely. Bytes past the limit
 * are discarded rather than accumulated, so the refusal is bounded in memory
 * whatever the caller does next; closing the socket is the call site's job (see
 * {@link refuseTooLarge}) because the response has to go out first.
 */
function readBinary(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        // Drop what was read: the request is refused, and holding a limit's
        // worth of it until the socket closes is the buffering this cap exists
        // to prevent.
        chunks = [];
        reject(new BodyTooLarge(limit));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (!done) reject(err);
    });
  });
}
