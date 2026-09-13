/**
 * A throwaway state directory for every test in this suite.
 *
 * `src/lib/drive-client.ts` resolves the local-data-server's SQLite path at
 * module load, and `@starkeep/app-client` refuses to hand a test runner the
 * operator's real `~/.starkeep`. Nothing here reads the database — the client
 * is mocked wherever a test touches it — but the path still has to resolve, so
 * it resolves somewhere empty.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STARKEEP_DIR ??= mkdtempSync(join(tmpdir(), "starkeep-drive-tests-"));
