/**
 * The starkeep-core checkout's current commit, read at request time.
 *
 * The local data server runs from source and keeps the code it started with,
 * and reports that start commit on `/health`. The Dashboard compares the two
 * and offers a restart when a pull has moved the checkout past the running
 * server.
 *
 * Response: `{ commit: string | null }`, null outside a git checkout.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { REPO_ROOT } from "../lib/exec-commands";

const run = promisify(execFile);

export async function GET(): Promise<Response> {
  try {
    const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT });
    return Response.json({ commit: stdout.trim() });
  } catch {
    return Response.json({ commit: null });
  }
}
