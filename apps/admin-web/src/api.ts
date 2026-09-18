/**
 * admin-web's server half: every `/api/*` route, on one Hono app.
 *
 * The route table used to be the shape of the `app/api/` directory tree, which
 * meant the paths were only readable by walking it. Here it is a list, and the
 * list is the thing to read.
 *
 * Each handler is a plain `(request, params?) => Response`, imported from its
 * own module under `./routes/`. That keeps them testable without a server —
 * `__tests__` calls most of them directly — while `__tests__/api-routing.test.ts`
 * drives this app to prove the paths and methods above actually reach them,
 * which is the half no per-module test can cover.
 *
 * **admin-web has no mount prefix and never will.** It carries no manifest,
 * installs nothing and never reaches Lambda, so there is no `/apps/<appId>` to
 * strip and no `honoUpstream` here. A deployed app's server half is the same
 * shape with that one wrapper around it.
 */

import { Hono } from "hono";

import * as appsList from "./routes/apps-list";
import * as appsInstall from "./routes/apps-install";
import * as appsUninstall from "./routes/apps-uninstall";
import * as appsRemoveNode from "./routes/apps-remove-node";
import * as appsCloudList from "./routes/apps-cloud-list";
import * as appsCloudInstall from "./routes/apps-cloud-install";
import * as appsInstallStatus from "./routes/apps-install-status";
import * as cloudDataServerInstall from "./routes/cloud-data-server-install";
import * as config from "./routes/config";
import * as costs from "./routes/costs";
import * as devices from "./routes/devices";
import * as driveInstall from "./routes/drive-install";
import * as execDaemon from "./routes/exec-daemon";
import * as execDaemonStatus from "./routes/exec-daemon-status";
import * as execDeployOutputs from "./routes/exec-deploy-outputs";
import * as execStream from "./routes/exec-stream";
import * as residency from "./routes/residency";
import * as residencyPolicy from "./routes/residency-policy";
import * as runtimeConfig from "./routes/runtime-config";

export const api = new Hono().basePath("/api");

// Apps: discovery, local install, cloud install.
api.get("/apps/list", () => appsList.GET());
api.post("/apps/install", (c) => appsInstall.POST(c.req.raw));
api.post("/apps/uninstall", (c) => appsUninstall.POST(c.req.raw));
api.post("/apps/remove-from-node", (c) => appsRemoveNode.POST(c.req.raw));
api.post("/apps/cloud/list", (c) => appsCloudList.POST(c.req.raw));
// `:appId` before the static `/apps/*` routes above would swallow them, so
// the static paths are declared first and Hono's router prefers them anyway —
// stated in both places rather than relying on either alone.
api.post("/apps/:appId/cloud-install", (c) =>
  appsCloudInstall.POST(c.req.raw, { params: Promise.resolve(c.req.param()) }),
);
api.get("/apps/:appId/install-status", (c) =>
  appsInstallStatus.GET(c.req.raw, { params: Promise.resolve(c.req.param()) }),
);

// Cloud setup: the two installs the wizard runs, and the config they write.
api.post("/cloud-data-server/install", (c) => cloudDataServerInstall.POST(c.req.raw));
api.post("/drive/install", (c) => driveInstall.POST(c.req.raw));
api.get("/config", () => config.GET());
api.patch("/config", (c) => config.PATCH(c.req.raw));
api.get("/exec/deploy-outputs", () => execDeployOutputs.GET());

// Cloud operations against the operator's own AWS credentials.
api.post("/costs", (c) => costs.POST(c.req.raw));
api.post("/devices", (c) => devices.POST(c.req.raw));
api.delete("/devices", (c) => devices.DELETE(c.req.raw));

// Daemons and long-running commands.
api.post("/exec/daemon", (c) => execDaemon.POST(c.req.raw));
api.get("/exec/daemon/status", (c) => execDaemonStatus.GET(c.req.raw));
api.post("/exec/stream", (c) => execStream.POST(c.req.raw));

// The local data server, proxied — see `routes/residency.ts` for why these go
// through the server rather than straight from the browser.
api.get("/residency", () => residency.GET());
api.post("/residency/policy", (c) => residencyPolicy.POST(c.req.raw));
api.put("/residency/policy", (c) => residencyPolicy.PUT(c.req.raw));

api.get("/runtime-config", () => runtimeConfig.GET());

// An unrouted `/api/*` path is a mistake in the browser half, and saying so in
// JSON keeps it from being parsed as the SPA shell — which is what a fallback
// to the client router would hand it.
api.all("*", (c) => c.json({ error: `No API route for ${c.req.method} ${c.req.path}` }, 404));
