/**
 * The example app's MCP endpoint: tools an outside client, such as Claude
 * Code, calls on the user's behalf.
 *
 * In the cloud the user creates a token for this app on the platform's
 * consent page (`<gateway URL>/connect?app=example-app`) and gives it to the
 * client, which sends it as `Authorization: Bearer skd_…` to
 * `<cloud URL>/apps/example-app/mcp`. The manifest declares the route
 * `auth: "delegated"`, so the gateway checks the token first.
 * `verifyDelegation` says whose request it is, and every data call forwards
 * the token, so the platform applies the token's mode to each one: a `read`
 * token lists, reads and tags files and reads notes, and the writing tools
 * answer with the platform's refusal.
 *
 * On the local surface any loopback caller reaches the tools with no token,
 * as the app's own pages do: `claude mcp add --transport http example
 * http://localhost:<port>/mcp`.
 *
 * The server speaks the JSON-RPC subset an MCP client needs over Streamable
 * HTTP, answering each request with one JSON response: `initialize`,
 * `tools/list`, `tools/call` and `ping`.
 */

import {
  delegationRefusal,
  loadAppCredentials,
  signedFetch,
  verifyDelegation,
  type AppCredentials,
  type DelegatedPrincipal,
} from "@starkeep/app-client";
import {
  APP_ID,
  EXAMPLE_TYPE,
  LABEL_KEYS,
  TABLES,
  decodeNote,
  encodeNote,
  textMetrics,
} from "@example-app/common";

const PROTOCOL_VERSION = "2025-06-18";

type Args = Record<string, unknown>;

class ToolError extends Error {}

interface Ctx {
  creds: AppCredentials;
  who: DelegatedPrincipal;
}

/** One data call, with the delegation's token when there is one. */
async function data(
  ctx: Ctx,
  method: string,
  path: string,
  body?: { json?: unknown; text?: string },
): Promise<unknown> {
  const res = await signedFetch(ctx.creds, path, {
    method,
    delegation: ctx.who.token,
    ...(body?.json !== undefined
      ? { body: JSON.stringify(body.json), headers: { "Content-Type": "application/json" } }
      : body?.text !== undefined
        ? { body: body.text, headers: { "Content-Type": "text/plain" } }
        : {}),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Keep the text.
  }
  if (!res.ok) {
    const reason =
      typeof parsed === "object" && parsed !== null && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : text.slice(0, 300);
    throw new ToolError(`The data server answered ${res.status}: ${reason}`);
  }
  return parsed;
}

function str(args: Args, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolError(`"${name}" is required`);
  }
  return value;
}

interface RecordRow {
  id: string;
  original_filename?: string | null;
  created_at?: string;
  labels?: { key: string; value?: string | null }[];
  metadata?: Record<string, unknown>;
}

function summarize(r: RecordRow) {
  return {
    id: r.id,
    name: r.original_filename ?? null,
    created: r.created_at ?? null,
    tags: (r.labels ?? []).filter((l) => l.key.endsWith(`/${LABEL_KEYS.tag}`)).map((l) => l.value),
    metrics: r.metadata ?? null,
  };
}

interface Tool {
  description: string;
  inputSchema: Record<string, unknown>;
  run(ctx: Ctx, args: Args): Promise<unknown>;
}

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
});

const TOOLS: Record<string, Tool> = {
  list_files: {
    description:
      "List the user's example files, newest first, with their tags and line, word and character counts. Optionally only files with one tag.",
    inputSchema: object({ tag: { type: "string", description: "Only files with this tag" } }),
    async run(ctx, args) {
      const params = new URLSearchParams({
        include: "metadata,labels",
        order: "created_at.desc",
        limit: "50",
      });
      if (typeof args.tag === "string" && args.tag) {
        params.set("label", `${APP_ID}/${LABEL_KEYS.tag}`);
        params.set("labelValue", args.tag);
      }
      const body = (await data(ctx, "GET", `/data/records?${params}`)) as {
        records: RecordRow[];
      };
      return body.records.map(summarize);
    },
  },
  read_file: {
    description: "Read one example file's text.",
    inputSchema: object({ recordId: { type: "string" } }, ["recordId"]),
    async run(ctx, args) {
      const id = encodeURIComponent(str(args, "recordId"));
      const { url } = (await data(ctx, "GET", `/data/records/${id}/file-url`)) as { url: string };
      const res = await fetch(url);
      if (!res.ok) throw new ToolError(`The file's content answered ${res.status}`);
      return await res.text();
    },
  },
  tag_file: {
    description: "Add a tag, such as draft or idea, to an example file.",
    inputSchema: object({ recordId: { type: "string" }, tag: { type: "string" } }, [
      "recordId",
      "tag",
    ]),
    async run(ctx, args) {
      await data(ctx, "POST", "/data/labels", {
        json: {
          labels: [
            { recordId: str(args, "recordId"), key: LABEL_KEYS.tag, value: str(args, "tag") },
          ],
        },
      });
      return "Tagged.";
    },
  },
  list_notes: {
    description: "List the user's notes about example files.",
    inputSchema: object({}),
    async run(ctx) {
      const body = (await data(ctx, "GET", `/app-data/db/${TABLES.notes}`)) as {
        rows: Record<string, unknown>[];
      };
      return body.rows.map(decodeNote);
    },
  },
  write_note: {
    description: "Write or replace the note about an example file. Needs read and write access.",
    inputSchema: object(
      {
        recordId: { type: "string" },
        text: { type: "string" },
        pinned: { type: "boolean" },
      },
      ["recordId", "text"],
    ),
    async run(ctx, args) {
      const row = encodeNote({
        recordId: str(args, "recordId"),
        text: str(args, "text"),
        pinned: args.pinned === true,
        updatedOn: new Date().toISOString(),
      });
      await data(ctx, "POST", `/app-data/db/${TABLES.notes}`, { json: { row } });
      return "Saved.";
    },
  },
  delete_note: {
    description: "Delete the note about an example file. Needs read and write access.",
    inputSchema: object({ recordId: { type: "string" } }, ["recordId"]),
    async run(ctx, args) {
      await data(ctx, "DELETE", `/app-data/db/${TABLES.notes}`, {
        json: { where: { record_id: str(args, "recordId") } },
      });
      return "Deleted.";
    },
  },
  create_file: {
    description: "Create a new example file from text. Needs read and write access.",
    inputSchema: object({ name: { type: "string" }, text: { type: "string" } }, ["name", "text"]),
    async run(ctx, args) {
      const text = str(args, "text");
      const raw = str(args, "name").replace(/\.skexample$/, "");
      const stored = (await data(
        ctx,
        "POST",
        `/data/files?type=${encodeURIComponent(EXAMPLE_TYPE)}`,
        { text },
      )) as { contentHash: string; sizeBytes: number };
      const body = (await data(ctx, "POST", "/data/records", {
        json: {
          type: EXAMPLE_TYPE,
          fileName: `${raw}.skexample`,
          contentType: "text/plain",
          contentHash: stored.contentHash,
          sizeBytes: stored.sizeBytes,
          metadata: textMetrics(text),
        },
      })) as { record: RecordRow };
      return summarize(body.record);
    },
  },
  trash_file: {
    description:
      "Move an example file to the Trash, where the user can still recover it. Needs read and write access.",
    inputSchema: object({ recordId: { type: "string" } }, ["recordId"]),
    async run(ctx, args) {
      await data(ctx, "DELETE", `/data/records/${encodeURIComponent(str(args, "recordId"))}`);
      return "Moved to the Trash.";
    },
  },
};

function result(id: unknown, value: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result: value });
}

function failure(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

/** Answer one MCP request. */
export async function handleMcp(req: Request): Promise<Response> {
  const who = await verifyDelegation(req);
  if (!who) return delegationRefusal();

  let message: { id?: unknown; method?: unknown; params?: Record<string, unknown> };
  try {
    message = (await req.json()) as typeof message;
  } catch {
    return failure(null, -32700, "Parse error");
  }
  const { id, method, params } = message;

  // A notification gets no answer but an acknowledgement.
  if (typeof method === "string" && method.startsWith("notifications/")) {
    return new Response(null, { status: 202 });
  }
  switch (method) {
    case "initialize":
      return result(id, {
        protocolVersion:
          typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "starkeep-example-app", version: "0.1.0" },
        instructions:
          "Tools over the user's Starkeep example files: plaintext files with tags, and one private note per file.",
      });
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, {
        tools: Object.entries(TOOLS).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case "tools/call": {
      const name = typeof params?.name === "string" ? params.name : "";
      const tool = TOOLS[name];
      if (!tool) return failure(id, -32602, `Unknown tool: ${name}`);
      const creds = await loadAppCredentials(APP_ID);
      if (!creds) return failure(id, -32603, `${APP_ID} has no credentials on this surface`);
      try {
        const value = await tool.run({ creds, who }, (params?.arguments ?? {}) as Args);
        const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
        return result(id, { content: [{ type: "text", text }], isError: false });
      } catch (err) {
        if (!(err instanceof ToolError)) throw err;
        return result(id, { content: [{ type: "text", text: err.message }], isError: true });
      }
    }
    default:
      return failure(id, -32601, `Method not found: ${String(method)}`);
  }
}
