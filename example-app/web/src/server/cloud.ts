/**
 * The cloud surface: the Lambda entry the manifest's `static` handler names.
 *
 * The platform's web adapter does everything a Lambda needs: it strips the
 * mount, encodes API Gateway payloads, serves the built browser half from
 * `assets/`, and hands every other request to the same Hono app the local
 * surface runs. `scripts/bundle.mjs` builds this file to `index.mjs` and stages
 * the browser half beside it.
 *
 * `createWebAppHandler` awaits the app's module graph at module scope, so the
 * graph loads during Lambda's INIT phase rather than inside the first request.
 */

import { createWebAppHandler } from "@starkeep/app-client/web";
import { honoUpstream } from "@starkeep/app-client/hono";
import manifest from "../../../starkeep.manifest.json" with { type: "json" };
import { staticOptions } from "./static-options.js";

export const handler = await createWebAppHandler({
  basePath: `/apps/${manifest.id}`,
  ...staticOptions(new URL("./assets/", import.meta.url)),
  requestUpstream: import("./app.js").then((m) => ({ handler: honoUpstream(m.app) })),
  // Answered rather than thrown: a thrown error becomes a bare 502 that says
  // nothing about what failed.
  onError: (err) => ({
    statusCode: 500,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: `example-app: ${String(err)}` }),
  }),
});
