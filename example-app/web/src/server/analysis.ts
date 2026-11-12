/**
 * `GET /api/notes-by-day`: an analysis read in SQL over a snapshot of the
 * app's own `notes` table.
 *
 * The row grammar has no date buckets, no `length` and no `avg` over an
 * expression, so this question cannot go to the data server as a query. The
 * platform's snapshot helper loads the notes through the row API into an
 * in-memory SQLite in this server, keeps the copy for five minutes, and runs
 * the statement below against it. The data server never sees the SQL.
 *
 * The answer carries `loadedAt`, when the copy's load started, so the page can
 * say how old the numbers are. The page's Refresh button sends `freshAfter`, a
 * floor that reloads any older copy. In the cloud each warm Lambda keeps its
 * own copy, and the floor reaches whichever one answers.
 *
 * The SQL lives here, in the server. A route must never run SQL text that
 * arrived from the browser.
 */

import {
  createSnapshotSql,
  SnapshotAccessError,
  SnapshotLoadError,
} from "@starkeep/app-client/snapshot";
import { APP_ID, TABLES } from "@example-app/common";
import manifest from "../../../starkeep.manifest.json" with { type: "json" };

const snapshots = createSnapshotSql({
  appId: APP_ID,
  tables: manifest.infraRequirements.appSpecificSyncable.tables,
});

const NOTES_BY_DAY = `
  SELECT substr(updated_on, 1, 10) AS day,
         count(*) AS notes,
         coalesce(sum(pinned), 0) AS pinned,
         round(avg(length(note)), 1) AS average_length
  FROM ${TABLES.notes}
  GROUP BY day
  ORDER BY day DESC`;

const MAX_AGE_MS = 5 * 60_000;

export async function notesByDay(req: Request): Promise<Response> {
  const floor = Number(new URL(req.url).searchParams.get("freshAfter") ?? "");
  try {
    const result = await snapshots.query(req, {
      tables: [TABLES.notes],
      sql: NOTES_BY_DAY,
      maxAge: MAX_AGE_MS,
      freshAfter: Number.isFinite(floor) ? floor : undefined,
    });
    const res = Response.json({ rows: result.rows, loadedAt: result.loadedAt });
    if (result.setCookie) res.headers.append("Set-Cookie", result.setCookie);
    return res;
  } catch (err) {
    if (err instanceof SnapshotAccessError || err instanceof SnapshotLoadError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
