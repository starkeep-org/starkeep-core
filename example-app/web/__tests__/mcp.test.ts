/**
 * The MCP endpoint's dispatch, tools and error answers, against a fake data
 * server.
 *
 * `signedFetch` and `loadAppCredentials` are stubbed, so each test states what
 * the data server answers and checks the JSON-RPC answer the client gets.
 * `verifyDelegation` stays real: outside cloud mode it admits a loopback
 * request with no token, as on the local surface.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** One data call the tools made, as the fake data server saw it. */
interface DataCall {
  method: string;
  path: string;
  body: unknown;
  delegation: unknown;
}

const calls: DataCall[] = [];
let answer: (call: DataCall) => Response = () => Response.json({}, { status: 500 });
let creds: unknown = { appId: "example-app", hmacSecret: "s", baseUrl: "http://lds" };

vi.mock("@starkeep/app-client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@starkeep/app-client")>();
  return {
    ...real,
    loadAppCredentials: async () => creds,
    signedFetch: async (
      _creds: unknown,
      path: string,
      init: { method?: string; body?: string; delegation?: unknown } = {},
    ) => {
      let body: unknown = init.body;
      try {
        body = init.body === undefined ? undefined : JSON.parse(init.body);
      } catch {
        // A text body, such as a file's content.
      }
      const call = { method: init.method ?? "GET", path, body, delegation: init.delegation };
      calls.push(call);
      return answer(call);
    },
  };
});

const { handleMcp } = await import("../src/server/mcp.js");

beforeEach(() => {
  calls.length = 0;
  creds = { appId: "example-app", hmacSecret: "s", baseUrl: "http://lds" };
  answer = () => Response.json({}, { status: 500 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function post(body: string): Promise<Response> {
  return handleMcp(
    new Request("http://127.0.0.1:4100/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "127.0.0.1:4100" },
      body,
    }),
  );
}

async function rpc(method: string, params?: Record<string, unknown>) {
  const res = await post(JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }));
  expect(res.status).toBe(200);
  return (await res.json()) as {
    id: unknown;
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };
}

async function tool(name: string, args: Record<string, unknown> = {}) {
  const body = await rpc("tools/call", { name, arguments: args });
  const result = body.result as { content: { type: string; text: string }[]; isError: boolean };
  return { text: result.content[0]!.text, isError: result.isError };
}

/** A record as both data servers put it on the wire: bare key, namespaced label. */
const RECORD = {
  id: "REC1",
  original_filename: "hello.skexample",
  created_at: "2026-11-16T10:00:00.000Z",
  metadata: { line_count: 2, word_count: 7, char_count: 41 },
  labels: [
    { app_id: "example-app", key: "tag", value: "mcp", label: "example-app/tag" },
    { app_id: "example-app", key: "tag", value: "idea", label: "example-app/tag" },
    { app_id: "example-app", key: "reviewed", value: "", label: "example-app/reviewed" },
    { app_id: "other-app", key: "tag", value: "theirs", label: "other-app/tag" },
  ],
};

describe("the JSON-RPC methods", () => {
  it("answers initialize with the client's protocol version and the tools capability", async () => {
    const body = await rpc("initialize", { protocolVersion: "2025-03-26" });
    expect(body.id).toBe(7);
    expect(body.result).toMatchObject({
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "starkeep-example-app" },
    });
  });

  it("answers ping with an empty result", async () => {
    expect((await rpc("ping")).result).toEqual({});
  });

  it("lists every tool, each with a description and an object schema", async () => {
    const tools = (await rpc("tools/list")).result!["tools"] as {
      name: string;
      description: string;
      inputSchema: { type: string };
    }[];
    expect(tools.map((t) => t.name)).toEqual([
      "list_files",
      "read_file",
      "tag_file",
      "list_notes",
      "write_note",
      "delete_note",
      "create_file",
      "trash_file",
    ]);
    for (const t of tools) {
      expect(t.description).not.toBe("");
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("acknowledges a notification with 202 and no body", async () => {
    const res = await post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("answers an unknown method with -32601", async () => {
    expect((await rpc("resources/list")).error).toEqual({
      code: -32601,
      message: "Method not found: resources/list",
    });
  });

  it("answers malformed JSON with a parse error and a null id", async () => {
    const res = await post("{not json");
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  });

  it("answers an unknown tool with -32602", async () => {
    expect((await rpc("tools/call", { name: "erase_everything" })).error).toEqual({
      code: -32602,
      message: "Unknown tool: erase_everything",
    });
  });

  it("answers -32603 when the app has no credentials on this surface", async () => {
    creds = null;
    expect((await rpc("tools/call", { name: "list_notes" })).error?.code).toBe(-32603);
    expect(calls).toEqual([]);
  });
});

describe("who may call", () => {
  it("refuses a request from a non-loopback host with the delegation refusal", async () => {
    const res = await handleMcp(
      new Request("http://attacker.example/mcp", {
        method: "POST",
        headers: { Host: "attacker.example" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toMatch(/^Bearer/);
    expect(res.headers.get("WWW-Authenticate")).not.toContain("invalid_token");
  });

  it("tells a client whose bearer token was refused that the token is invalid", async () => {
    const res = await handleMcp(
      new Request("http://attacker.example/mcp", {
        method: "POST",
        headers: { Host: "attacker.example", Authorization: "Bearer stale" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
  });

  it("forwards no delegation token on the local surface", async () => {
    answer = () => Response.json({ rows: [] });
    await tool("list_notes");
    expect(calls[0]!.delegation).toBeNull();
  });
});

describe("the tools", () => {
  it("list_files reports this app's tags, and no other app's", async () => {
    answer = () => Response.json({ records: [RECORD] });
    const { text, isError } = await tool("list_files");
    expect(isError).toBe(false);
    expect(JSON.parse(text)).toEqual([
      {
        id: "REC1",
        name: "hello.skexample",
        created: "2026-11-16T10:00:00.000Z",
        tags: ["mcp", "idea"],
        metrics: { line_count: 2, word_count: 7, char_count: 41 },
      },
    ]);
    const params = new URL(calls[0]!.path, "http://x").searchParams;
    expect(params.get("include")).toBe("metadata,labels");
    expect(JSON.parse(params.get("order")!)).toEqual([{ col: "created_at", dir: "desc" }]);
    expect(params.has("label")).toBe(false);
  });

  it("list_files with a tag asks the server to filter on the app's tag key", async () => {
    answer = () => Response.json({ records: [] });
    await tool("list_files", { tag: "mcp" });
    const params = new URL(calls[0]!.path, "http://x").searchParams;
    expect(params.get("label")).toBe("example-app/tag");
    expect(params.get("labelValue")).toBe("mcp");
  });

  it("read_file fetches the signed URL the data server answers", async () => {
    answer = () => Response.json({ url: "https://signed.example/REC%201" });
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(url);
      return new Response("Hello, Starkeep.");
    });
    expect(await tool("read_file", { recordId: "REC 1" })).toEqual({
      text: "Hello, Starkeep.",
      isError: false,
    });
    expect(calls[0]!.path).toBe("/data/records/REC%201/file-url");
    expect(fetched).toEqual(["https://signed.example/REC%201"]);
  });

  it("read_file reports a failed content fetch as a tool error", async () => {
    answer = () => Response.json({ url: "https://signed.example/x" });
    vi.stubGlobal("fetch", async () => new Response("gone", { status: 403 }));
    expect(await tool("read_file", { recordId: "REC1" })).toEqual({
      text: "The file's content answered 403",
      isError: true,
    });
  });

  it("tag_file posts one tag label with the bare key", async () => {
    answer = () => Response.json({ ok: true });
    expect(await tool("tag_file", { recordId: "REC1", tag: "draft" })).toEqual({
      text: "Tagged.",
      isError: false,
    });
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/data/labels",
      body: { labels: [{ recordId: "REC1", key: "tag", value: "draft" }] },
    });
  });

  it("list_notes decodes the table's rows", async () => {
    answer = () =>
      Response.json({
        rows: [{ record_id: "REC1", note: "hi", pinned: true, updated_on: "2026-11-16" }],
      });
    expect(JSON.parse((await tool("list_notes")).text)).toEqual([
      { recordId: "REC1", text: "hi", pinned: true, updatedOn: "2026-11-16" },
    ]);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/app-data/db/notes" });
  });

  it("write_note writes an encoded row, unpinned unless asked", async () => {
    answer = () => Response.json({ ok: true });
    expect((await tool("write_note", { recordId: "REC1", text: "hi" })).text).toBe("Saved.");
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/app-data/db/notes",
      body: { row: { record_id: "REC1", note: "hi", pinned: false } },
    });
  });

  it("delete_note deletes by record id", async () => {
    answer = () => Response.json({ ok: true });
    expect((await tool("delete_note", { recordId: "REC1" })).text).toBe("Deleted.");
    expect(calls[0]).toMatchObject({
      method: "DELETE",
      path: "/app-data/db/notes",
      body: { where: { record_id: "REC1" } },
    });
  });

  it("create_file stores the text, registers the record with its counts, and summarizes it", async () => {
    answer = (call) =>
      call.path.startsWith("/data/files")
        ? Response.json({ key: "k", contentHash: "abc", sizeBytes: 26 })
        : Response.json({ record: { ...RECORD, original_filename: "from-mcp.skexample" } });
    const summary = JSON.parse(
      (await tool("create_file", { name: "from-mcp.skexample", text: "Written by an MCP client." }))
        .text,
    ) as { name: string; tags: string[] };
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /data/files?type=example%2Fplaintext",
      "POST /data/records",
    ]);
    expect(calls[0]!.body).toBe("Written by an MCP client.");
    expect(calls[1]!.body).toMatchObject({
      type: "example/plaintext",
      fileName: "from-mcp.skexample",
      contentHash: "abc",
      sizeBytes: 26,
      metadata: { line_count: 1, word_count: 5, char_count: 25 },
    });
    expect(summary.name).toBe("from-mcp.skexample");
    expect(summary.tags).toEqual(["mcp", "idea"]);
  });

  it("trash_file deletes the record", async () => {
    answer = () => Response.json({ ids: ["REC 1"] });
    expect(await tool("trash_file", { recordId: "REC 1" })).toEqual({
      text: "Moved to the Trash.",
      isError: false,
    });
    expect(calls[0]).toMatchObject({ method: "DELETE", path: "/data/records/REC%201" });
  });

  it("answers a missing argument as a tool error, before any data call", async () => {
    expect(await tool("tag_file", { recordId: "REC1" })).toEqual({
      text: '"tag" is required',
      isError: true,
    });
    expect(calls).toEqual([]);
  });

  it("passes the data server's refusal through as a tool error", async () => {
    answer = () => Response.json({ error: "read-only delegation" }, { status: 403 });
    expect(await tool("trash_file", { recordId: "REC1" })).toEqual({
      text: "The data server answered 403: read-only delegation",
      isError: true,
    });
  });

  it("quotes the start of a refusal that is not JSON", async () => {
    answer = () => new Response("Bad gateway", { status: 502 });
    expect((await tool("list_notes")).text).toBe("The data server answered 502: Bad gateway");
  });
});
