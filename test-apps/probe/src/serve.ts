/**
 * The local surface: `node:http` ↔ web `Request`/`Response`.
 *
 * A locally installed app is started by admin-web's daemon route, which spawns
 * the manifest's `localRun` command and passes the port it allocated on
 * `portFlag`. Probe's `localRun` runs the built `serve.mjs`, which is this file
 * bundled — a local install therefore needs no dependency install of its own,
 * which is what lets the tier-2 harness treat it as a throwaway fixture.
 */

import { createServer } from "node:http";
import { handleRequest } from "./app.js";

function portFromArgv(argv: string[]): number {
  const at = argv.indexOf("--port");
  const value = at >= 0 ? Number(argv[at + 1]) : Number(process.env.PORT);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      "probe needs a port: --port <n> (admin-web passes it via the manifest portFlag)",
    );
  }
  return value;
}

const port = portFromArgv(process.argv.slice(2));

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(", "));
      }
      const method = req.method ?? "GET";
      const hasBody = method !== "GET" && method !== "HEAD" && chunks.length > 0;
      const request = new Request(url.toString(), {
        method,
        headers,
        ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
      });

      let response: Response;
      try {
        response = await handleRequest(request, url.pathname);
      } catch (err) {
        response = new Response(JSON.stringify({ error: `probe: ${String(err)}` }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }

      const out: Record<string, string | string[]> = {};
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() !== "set-cookie") out[key] = value;
      });
      const setCookies = response.headers.getSetCookie();
      if (setCookies.length) out["set-cookie"] = setCookies;
      res.writeHead(response.status, out);
      res.end(Buffer.from(await response.arrayBuffer()));
    })();
  });
}).listen(port, "127.0.0.1", () => {
  console.log(`probe listening on http://127.0.0.1:${port}`);
});
