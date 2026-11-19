import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A temporary folder to act as STARKEEP_DIR. */
export function makeDataDir(prefix = "operator-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
