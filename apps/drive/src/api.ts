/**
 * Drive's server half: every `/api/*` route, on one Hono app.
 *
 * The route table used to be the shape of the `app/api/` directory tree, which
 * meant the paths were only readable by walking it. Here it is a list, and the
 * list is the thing to read.
 *
 * Each handler is a plain `(request, id?) => Response` imported from its own
 * module under `./routes/`, so `__tests__` can call one without standing up a
 * server. `__tests__/api-routing.test.ts` drives this app instead, which is the
 * half no per-module test can cover.
 *
 * **Drive has no mount prefix and never will.** It carries no manifest,
 * installs nothing and never reaches Lambda, so there is no `/apps/<appId>` to
 * strip and no `honoUpstream` here.
 */

import { Hono } from "hono";

import * as events from "./routes/events";
import * as records from "./routes/records";
import * as recordFile from "./routes/record-file";
import * as types from "./routes/types";

export const api = new Hono().basePath("/api");

api.get("/events", (c) => events.GET(c.req.raw));
api.get("/records", (c) => records.GET(c.req.raw));
// The dynamic segment arrives decoded from Hono, which is what the handler
// needs: a record id is signed and looked up as itself, and the framework this
// replaced handed Memo an encoded one — every deck reported "Deck not found".
api.get("/records/:id/file", (c) => recordFile.GET(c.req.raw, c.req.param("id")));
api.get("/types", () => types.GET());

// An unrouted `/api/*` path is a mistake in the browser half, and saying so in
// JSON keeps it from being parsed as the shell — which is what a fallback to
// the client would hand it.
api.all("*", (c) => c.json({ error: `No API route for ${c.req.method} ${c.req.path}` }, 404));
