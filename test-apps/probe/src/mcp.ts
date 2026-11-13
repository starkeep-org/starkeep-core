/**
 * Probe's MCP endpoint: the smallest server an outside client can call with a
 * delegation token, so the platform's suites can drive every row of the
 * delegation mode table through a real app route.
 *
 * It speaks the JSON-RPC subset an MCP client needs to list and call tools:
 * `initialize`, `tools/list` and `tools/call`. Each tool makes one data call
 * and answers with the data server's status and body as text, so a suite can
 * assert a refusal as precisely as a success.
 *
 * The route is declared `{ "route": "POST /mcp", "auth": "delegated" }` in the
 * manifest, so in the cloud the gateway checks the token first. The handler
 * still calls `verifyDelegation`, and forwards the token on every data call,
 * so the platform applies the delegation's mode and revocation to each one.
 * On the local surface a loopback caller passes with no token.
 */

import {
  delegationRefusal,
  loadAppCredentials,
  signedFetch,
  verifyDelegation,
  type DelegatedPrincipal,
} from "@starkeep/app-client";

interface Tool {
  description: string;
  inputSchema: Record<string, unknown>;
  call(args: Record<string, unknown>): { method: string; path: string; body?: unknown };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const TOOLS: Record<string, Tool> = {
  list_records: {
    description: "List up to ten of the user's records that Probe may read.",
    inputSchema: { type: "object", properties: {} },
    call: () => ({ method: "GET", path: "/data/records?limit=10" }),
  },
  add_label: {
    description: "Tag a record with Probe's `tag` label.",
    inputSchema: {
      type: "object",
      properties: { recordId: { type: "string" }, value: { type: "string" } },
      required: ["recordId", "value"],
    },
    call: (a) => ({
      method: "POST",
      path: "/data/labels",
      body: { labels: [{ recordId: str(a.recordId), key: "tag", value: str(a.value) }] },
    }),
  },
  list_notes: {
    description: "Read Probe's notes.",
    inputSchema: { type: "object", properties: {} },
    call: () => ({ method: "GET", path: "/app-data/db/probe_notes" }),
  },
  add_note: {
    description: "Write a note about a record.",
    inputSchema: {
      type: "object",
      properties: { recordId: { type: "string" }, note: { type: "string" } },
      required: ["recordId", "note"],
    },
    call: (a) => ({
      method: "POST",
      path: "/app-data/db/probe_notes",
      body: { row: { record_id: str(a.recordId), note: str(a.note) } },
    }),
  },
  delete_note: {
    description: "Delete a note. The row becomes a tombstone.",
    inputSchema: {
      type: "object",
      properties: { recordId: { type: "string" } },
      required: ["recordId"],
    },
    call: (a) => ({
      method: "DELETE",
      path: "/app-data/db/probe_notes",
      body: { where: { record_id: str(a.recordId) } },
    }),
  },
  erase_file: {
    description: "Erase one of Probe's own files. No delegation may do this.",
    inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    call: (a) => ({
      method: "DELETE",
      path: `/app-data/files/${encodeURIComponent(str(a.key))}`,
    }),
  },
};

function rpc(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

async function callTool(
  appId: string,
  who: DelegatedPrincipal,
  name: string,
  args: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const tool = TOOLS[name];
  if (!tool) return { status: 404, body: { error: `No tool called ${name}` } };
  const creds = await loadAppCredentials(appId);
  if (!creds) return { status: 503, body: { error: `${appId} has no credentials here` } };
  const { method, path, body } = tool.call(args);
  const res = await signedFetch(creds, path, {
    method,
    delegation: who.token,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Keep the raw text.
  }
  return { status: res.status, body: parsed };
}

/** Answer one MCP request. */
export async function handleMcp(appId: string, req: Request): Promise<Response> {
  const who = await verifyDelegation(req);
  if (!who) return delegationRefusal();

  let message: { id?: unknown; method?: unknown; params?: Record<string, unknown> };
  try {
    message = (await req.json()) as typeof message;
  } catch {
    return rpcError(null, -32700, "Parse error");
  }
  const { id, method, params } = message;
  if (method === "initialize") {
    return rpc(id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "probe", version: "0.1.0" },
    });
  }
  if (method === "notifications/initialized") return new Response(null, { status: 202 });
  if (method === "tools/list") {
    return rpc(id, {
      tools: Object.entries(TOOLS).map(([name, t]) => ({
        name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  }
  if (method === "tools/call") {
    const name = str(params?.name);
    const args = (params?.arguments ?? {}) as Record<string, unknown>;
    const result = await callTool(appId, who, name, args);
    return rpc(id, {
      content: [{ type: "text", text: JSON.stringify(result) }],
      isError: result.status >= 400,
    });
  }
  return rpcError(id, -32601, `Method not found: ${str(method)}`);
}
