/**
 * The browser entry point.
 *
 * Everything below this line runs in the browser and nothing else does, which
 * is the property `server-only` used to assert and that
 * `__tests__/server-module-isolation.test.ts` now holds: no module reachable
 * from here may touch `node:child_process` or `node:fs`.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import "./globals.css";

const root = document.getElementById("root");
if (!root) throw new Error("admin-web: index.html has no #root to mount into");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
