/**
 * Every test file gets a throwaway STARKEEP_DIR unless it set its own, because
 * several modules resolve it when they load, and app-client refuses the real
 * `~/.starkeep` under a test runner.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STARKEEP_DIR ??= mkdtempSync(join(tmpdir(), "cli-test-"));
