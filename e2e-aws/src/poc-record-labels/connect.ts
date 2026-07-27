/**
 * Connection helper for the cross-app-label schema POC.
 *
 * Talks to a **disposable** DSQL cluster created for this experiment only —
 * never the cloud-data-server's cluster. The identifier must be passed
 * explicitly (env `POC_DSQL_CLUSTER`) so there is no default that could point
 * at a real deployment.
 */

import pg from "pg";
import { DsqlSigner } from "@aws-sdk/dsql-signer";

export const REGION = process.env.POC_DSQL_REGION ?? "us-east-2";

export function clusterId(): string {
  const id = process.env.POC_DSQL_CLUSTER;
  if (!id) {
    throw new Error(
      "POC_DSQL_CLUSTER must name the disposable POC cluster (never a live one).",
    );
  }
  return id;
}

export function endpoint(): string {
  return `${clusterId()}.dsql.${REGION}.on.aws`;
}

/** A fresh admin connection. DSQL auth tokens are short-lived, so mint per client. */
export async function connect(): Promise<pg.Client> {
  const host = endpoint();
  const signer = new DsqlSigner({ hostname: host, region: REGION });
  const token = await signer.getDbConnectAdminAuthToken();
  const client = new pg.Client({
    host,
    port: 5432,
    database: "postgres",
    user: "admin",
    password: token,
    ssl: { rejectUnauthorized: true },
  });
  await client.connect();
  return client;
}

/** Run `sql`, returning either the rows or the error — experiments assert on both. */
export async function tryQuery(
  client: pg.Client,
  sql: string,
  params?: unknown[],
): Promise<{ ok: true; rows: unknown[] } | { ok: false; code?: string; message: string }> {
  try {
    const res = await client.query(sql, params as never);
    return { ok: true, rows: res.rows };
  } catch (err) {
    const e = err as { code?: string; message: string };
    return { ok: false, code: e.code, message: e.message };
  }
}

/** Median of a set of timings, in ms. */
export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

/** Time `fn` `runs` times, returning the median wall time in ms. */
export async function timeIt<T>(runs: number, fn: () => Promise<T>): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  return median(times);
}
