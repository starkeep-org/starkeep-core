import type { IncomingMessage, ServerResponse } from "node:http";
import type { HLCClock } from "@starkeep/protocol-primitives";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";
import { createInProcessSyncTransport } from "./in-process-transport.js";
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

  return async (req, res) => {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host ?? "localhost"}`,
    );

    if (req.method === "POST" && url.pathname === "/sync/exchange") {
      const body = await readJson<SyncExchangeRequest>(req);
      const response = await transport.exchange(body);
      sendJson(res, 200, response);
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
        const bytes = await readBinary(req);
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

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const buf = await readBinary(req);
  return JSON.parse(buf.toString("utf-8")) as T;
}

function readBinary(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
