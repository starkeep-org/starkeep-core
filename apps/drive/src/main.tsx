/**
 * The browser entry point.
 *
 * Everything below this line runs in the browser and nothing else does, which
 * is what `__tests__/server-module-isolation.test.ts` holds: no module
 * reachable from here may touch `node:sqlite`, `node:fs` or the HMAC-signing
 * client that reads the local-data-server's registry. Drive's whole reason for
 * having a server half is that the browser cannot hold its credential.
 *
 * **No router.** Drive is one screen. `src/server.ts` answers `/` with this
 * shell and 404s everything else, so there is no second path for a router to
 * choose between.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./globals.css";

const root = document.getElementById("root");
if (!root) throw new Error("drive: index.html has no #root to mount into");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
