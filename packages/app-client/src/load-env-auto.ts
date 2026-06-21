/**
 * Side-effect entry: importing this module loads the repo-root `.env` /
 * `.env.local` into `process.env` once, at import time. Node entry points
 * (`apps/local-data-server/server.ts`, the `packages/admin-installer/scripts/*`
 * CLIs) import this as their *first* import so `STARKEEP_DIR` is populated before
 * any module reads it. Kept out of `src/index.ts` so `dotenv`/`fs` never get
 * pulled into client/browser bundles — import this explicitly where needed.
 */
import { loadStarkeepEnv } from "./load-env.js";

loadStarkeepEnv();
