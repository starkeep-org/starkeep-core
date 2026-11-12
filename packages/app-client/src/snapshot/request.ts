/**
 * The snapshot cache bound to a request: who is asking, and how their rows
 * arrive.
 *
 * The rules match the signing proxy's (`../data-proxy.ts`), because this is the
 * same app server reading the same data for the same person:
 *
 * - a request a page on another site sent is refused on both surfaces;
 * - in the cloud a request with no valid session is refused before the app's
 *   credential is read;
 * - on the local surface no end user is asked for, and one scope covers the
 *   machine, because the local data server serves one person.
 *
 * Rows arrive through the row API, `GET /app-data/db/<table>`, signed with the
 * app's credential and, in the cloud, carrying the user's ID token. The data
 * server has already removed other users' rows, tombstones and system columns,
 * which is what makes the copy safe to query freely.
 */

import type { SQLInputValue } from "node:sqlite";
import { loadAppCredentials, type AppCredentials } from "../credentials.js";
import type { MinimalRequest } from "../data-proxy.js";
import { fromAnotherSite } from "../local-guard.js";
import { proxyToDataServer } from "../proxy.js";
import {
  createSnapshotCache,
  type SnapshotLoadContext,
  type SnapshotResult,
  type SnapshotRow,
  type SnapshotTable,
} from "./cache.js";
import { SnapshotAccessError, SnapshotLoadError, SnapshotTooLargeError } from "./errors.js";

/** The row API's largest page. */
const PAGE_SIZE = 500;

/** The scope every local query shares. */
const LOCAL_SCOPE = "local";

export interface SnapshotSqlOptions {
  /** The app id whose credential signs the loads. */
  appId: string;
  /** The manifest's `infraRequirements.appSpecificSyncable.tables`. */
  tables: readonly SnapshotTable[];
  /** See {@link import("./cache.js").SnapshotCacheOptions.maxEntries}. */
  maxEntries?: number;
  /** See {@link import("./cache.js").SnapshotCacheOptions.maxRows}. */
  maxRows?: number;
}

export interface SnapshotSqlQuery {
  /** The tables the statement reads. */
  tables: readonly string[];
  /**
   * One read-only statement, written in the app's server code. Never pass SQL
   * text that arrived from the browser: the snapshot holds only the caller's
   * own rows, but an arbitrary statement has no cost bound.
   */
  sql: string;
  params?: readonly SQLInputValue[] | Record<string, SQLInputValue>;
  /** Milliseconds a snapshot may age before a reload. */
  maxAge: number;
  /** Epoch milliseconds from the browser. A Refresh action sets it to now. */
  freshAfter?: number;
}

export interface SnapshotSqlResult extends SnapshotResult {
  /**
   * Present when the user's ID token was re-minted. Append it to the response
   * as `Set-Cookie`, or the browser keeps the old token.
   */
  setCookie?: string;
}

export interface SnapshotSql {
  query(req: MinimalRequest, q: SnapshotSqlQuery): Promise<SnapshotSqlResult>;
  /** Drop every snapshot. */
  clear(): void;
}

function isCloudMode(): boolean {
  return process.env.STARKEEP_APP_CLIENT_MODE === "cloud";
}

/**
 * Analysis reads in SQL over a cached copy of the app's own tables.
 *
 * ```ts
 * const snapshots = createSnapshotSql({
 *   appId: APP_ID,
 *   tables: manifest.infraRequirements.appSpecificSyncable.tables,
 * });
 * app.get("/api/weekly-volume", async (c) => {
 *   const result = await snapshots.query(c.req.raw, {
 *     tables: ["sets"],
 *     sql: WEEKLY_VOLUME_SQL,
 *     maxAge: 5 * 60_000,
 *     freshAfter: Number(c.req.query("freshAfter") ?? 0),
 *   });
 *   const res = Response.json({ rows: result.rows, loadedAt: result.loadedAt });
 *   if (result.setCookie) res.headers.append("Set-Cookie", result.setCookie);
 *   return res;
 * });
 * ```
 */
export function createSnapshotSql(opts: SnapshotSqlOptions): SnapshotSql {
  const cache = createSnapshotCache({
    tables: opts.tables,
    maxEntries: opts.maxEntries,
    maxRows: opts.maxRows,
  });

  return {
    async query(req, q) {
      if (fromAnotherSite(req)) {
        throw new SnapshotAccessError("Cross-site request refused", 403);
      }

      let scope = LOCAL_SCOPE;
      let userToken: string | undefined;
      let setCookie: string | undefined;
      if (isCloudMode()) {
        const { mintIdToken } = await import("../auth/session.js");
        const minted = await mintIdToken(req, opts.appId);
        if (!minted) throw new SnapshotAccessError("Not authenticated", 401);
        scope = minted.claims.sub;
        userToken = minted.token;
        setCookie = minted.setCookie;
      }

      // Read once per query, and only if a load runs.
      let creds: AppCredentials | undefined;
      const load = async (table: string, ctx: SnapshotLoadContext) => {
        if (!creds) {
          const loaded = await loadAppCredentials(opts.appId);
          if (!loaded) {
            throw new SnapshotAccessError(
              `${opts.appId} has not been installed — run install from admin-web first`,
              503,
            );
          }
          creds = loaded;
        }
        return loadTable(creds, table, userToken, ctx);
      };

      const result = await cache.query({
        scope,
        tables: q.tables,
        load,
        sql: q.sql,
        params: q.params,
        maxAge: q.maxAge,
        freshAfter: q.freshAfter,
      });
      return setCookie ? { ...result, setCookie } : result;
    },
    clear: () => cache.clear(),
  };
}

interface RowPage {
  rows?: SnapshotRow[];
  page_token?: string | null;
  error?: string;
}

/** Every live row of one table, a page at a time, in primary-key order. */
async function loadTable(
  creds: AppCredentials,
  table: string,
  userToken: string | undefined,
  ctx: SnapshotLoadContext,
): Promise<SnapshotRow[]> {
  const rows: SnapshotRow[] = [];
  let pageToken: string | null | undefined;
  do {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (pageToken) query.set("page_token", pageToken);
    const path = `/app-data/db/${encodeURIComponent(table)}?${query.toString()}`;
    const res = await proxyToDataServer(creds, { method: "GET", path, headers: {}, userToken });
    const text = res.body ? await new Response(res.body).text() : "";
    let page: RowPage = {};
    try {
      page = text ? (JSON.parse(text) as RowPage) : {};
    } catch {
      // Not JSON; the status says what went wrong.
    }
    if (res.status !== 200 || !Array.isArray(page.rows)) {
      throw new SnapshotLoadError(
        `loading "${table}" failed with ${res.status}${page.error ? `: ${page.error}` : ""}`,
        res.status === 200 ? 502 : res.status,
      );
    }
    rows.push(...page.rows);
    if (rows.length > ctx.remainingRows) throw new SnapshotTooLargeError(ctx.remainingRows);
    pageToken = page.page_token;
  } while (pageToken);
  return rows;
}
