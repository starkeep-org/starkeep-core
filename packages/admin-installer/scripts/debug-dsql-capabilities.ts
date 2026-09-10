/**
 * Probe which SQL expression features Aurora DSQL actually supports.
 *
 * The AWS documentation lists supported data types, SELECT clauses and DDL
 * commands, and says nothing about functions or operators beyond "this list is
 * not exhaustive". So questions like "does `~` work" have no documented answer
 * and are settled only by asking the cluster.
 *
 * Every probe is a bare `SELECT <expression>` needing no table, no schema and
 * no write, so this is safe to run against a live cluster at any time. Each
 * runs in its own transaction; a failing probe reports its SQLSTATE and the
 * run continues.
 *
 * Same credential and bootstrap path as debug-dsql-inspect.ts: admin
 * connections need dsql:DbConnectAdmin, which only the install-ddl-role holds,
 * so this attaches a uniquely-named temp policy and detaches it on exit.
 *
 * Run via:
 *   pnpm -F @starkeep/admin-installer debug:dsql-capabilities
 *
 * Pass `--ddl` to additionally answer whether a `tsvector` column can be stored
 * and indexed, which no expression-level probe can reach. That path creates one
 * uniquely-named table, inserts one row, tries two index shapes and drops the
 * table again, so it writes to the cluster where the default run does not.
 */

// First import: load repo-root .env / .env.local so STARKEEP_DIR is populated.
import "@starkeep/app-client/load-env";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import {
  IAMClient,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import pg from "pg";

interface Creds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface StarkeepConfig {
  accountId: string;
  stackPrefix: string;
  managerRoleArn: string;
  auroraEndpoint: string;
  region?: string;
}

/**
 * One probe per question the query-plane plan needs answered.
 *
 * `group` sorts the report; `sql` must be a single self-contained expression.
 * `expect` records what the plan currently assumes, so a surprise is visible in
 * the output rather than only in whoever reads it.
 */
interface Probe {
  group: string;
  what: string;
  sql: string;
  expect: "supported" | "unsupported" | "unknown";
}

const PROBES: Probe[] = [
  // --- POSIX regular expressions (Q4's request) --------------------------
  { group: "regex", what: "~ (POSIX match)", sql: `SELECT 'abc' ~ 'a.c'`, expect: "unknown" },
  { group: "regex", what: "~* (case-insensitive)", sql: `SELECT 'abc' ~* 'A.C'`, expect: "unknown" },
  { group: "regex", what: "!~ (negated)", sql: `SELECT 'abc' !~ 'x.z'`, expect: "unknown" },
  { group: "regex", what: "!~* (negated, ci)", sql: `SELECT 'abc' !~* 'X.Z'`, expect: "unknown" },
  { group: "regex", what: "regexp_like()", sql: `SELECT regexp_like('abc', 'a.c')`, expect: "unknown" },
  { group: "regex", what: "regexp_match()", sql: `SELECT regexp_match('abc', '(a)(b)')`, expect: "unknown" },
  { group: "regex", what: "regexp_replace()", sql: `SELECT regexp_replace('abc', 'b', 'X')`, expect: "unknown" },
  { group: "regex", what: "regexp_split_to_array()", sql: `SELECT regexp_split_to_array('a,b', ',')`, expect: "unknown" },
  { group: "regex", what: "substring(x from pattern)", sql: `SELECT substring('abc' from 'b')`, expect: "unknown" },
  // POSIX character classes are the part JavaScript's regex engine does not
  // have, so this probe is what decides whether one pattern language can span
  // both backends or only a documented subset can.
  { group: "regex", what: "POSIX class [[:alpha:]]", sql: `SELECT 'abc' ~ '[[:alpha:]]+'`, expect: "unknown" },

  // --- Pattern matching short of regex ------------------------------------
  { group: "pattern", what: "LIKE", sql: `SELECT 'abc' LIKE 'a%'`, expect: "unknown" },
  { group: "pattern", what: "ILIKE", sql: `SELECT 'abc' ILIKE 'A%'`, expect: "unknown" },
  { group: "pattern", what: "SIMILAR TO", sql: `SELECT 'abc' SIMILAR TO 'a%'`, expect: "unknown" },
  { group: "pattern", what: "starts_with()", sql: `SELECT starts_with('abc', 'a')`, expect: "unknown" },
  // The portable prefix predicate the plan would actually emit: a half-open
  // range, which is an index seek rather than a scan on both engines.
  { group: "pattern", what: "range prefix (>= AND <)", sql: `SELECT 'abc' >= 'a' AND 'abc' < 'b'`, expect: "supported" },

  // --- Full-text search ----------------------------------------------------
  // tsvector and tsquery are absent from DSQL's supported-data-types page, so
  // these are expected to fail. Probing anyway: the page describes stored
  // column types, and an expression-only use might still resolve.
  { group: "fts", what: "to_tsvector()", sql: `SELECT to_tsvector('english', 'a quick fox')`, expect: "unsupported" },
  { group: "fts", what: "websearch_to_tsquery()", sql: `SELECT websearch_to_tsquery('english', 'fox')`, expect: "unsupported" },
  { group: "fts", what: "@@ (tsvector match)", sql: `SELECT to_tsvector('a fox') @@ to_tsquery('fox')`, expect: "unsupported" },
  { group: "fts", what: "tsvector cast", sql: `SELECT 'a fox'::tsvector`, expect: "unsupported" },
  // The cast above succeeded on the first run, which contradicted the AWS
  // supported-data-types page. These separate the type from the linguistic
  // configuration: the parse and match machinery may exist while the dictionary
  // that `to_tsvector('english', ...)` needs does not.
  { group: "fts", what: "tsquery cast", sql: `SELECT 'fox'::tsquery`, expect: "unknown" },
  { group: "fts", what: "@@ with no config", sql: `SELECT 'a fox'::tsvector @@ 'fox'::tsquery`, expect: "unknown" },
  { group: "fts", what: "pg_typeof(tsvector)", sql: `SELECT pg_typeof('a fox'::tsvector)`, expect: "unknown" },
  { group: "fts", what: "to_tsvector('simple')", sql: `SELECT to_tsvector('simple', 'a fox')`, expect: "unknown" },
  { group: "fts", what: "plainto_tsquery('simple')", sql: `SELECT plainto_tsquery('simple', 'fox')`, expect: "unknown" },
  { group: "fts", what: "available ts configs", sql: `SELECT coalesce(string_agg(cfgname, ','), '(none)') FROM pg_ts_config`, expect: "unknown" },
  { group: "fts", what: "available ts dictionaries", sql: `SELECT count(*) FROM pg_ts_dict`, expect: "unknown" },
  { group: "fts", what: "ts_rank()", sql: `SELECT ts_rank('a fox'::tsvector, 'fox'::tsquery)`, expect: "unknown" },

  // --- Aggregates the plan commits to (see the grammar section) -----------
  { group: "aggregate", what: "count(DISTINCT x)", sql: `SELECT count(DISTINCT v) FROM (VALUES (1),(1),(2)) t(v)`, expect: "supported" },
  { group: "aggregate", what: "avg(int) return type", sql: `SELECT avg(v), pg_typeof(avg(v)) FROM (VALUES (1),(2)) t(v)`, expect: "supported" },
  { group: "aggregate", what: "avg(int)::double precision", sql: `SELECT avg(v)::double precision FROM (VALUES (1),(2)) t(v)`, expect: "supported" },
  { group: "aggregate", what: "sum over zero rows", sql: `SELECT sum(v) FROM (VALUES (1)) t(v) WHERE false`, expect: "supported" },
  { group: "aggregate", what: "bare column under GROUP BY", sql: `SELECT max(a), b FROM (VALUES (1,2)) t(a,b)`, expect: "unsupported" },
];

function loadStarkeepConfig(): StarkeepConfig {
  const path = join(process.env.STARKEEP_DIR ?? join(homedir(), ".starkeep"), "config.json");
  return JSON.parse(readFileSync(path, "utf8")) as StarkeepConfig;
}

function loadBaseCreds(): Creds {
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    };
  }
  const cached = join(homedir(), ".starkeep", "cloud-credentials.json");
  if (existsSync(cached)) {
    const raw = JSON.parse(readFileSync(cached, "utf8")) as Creds & { expiration?: string };
    return {
      accessKeyId: raw.accessKeyId,
      secretAccessKey: raw.secretAccessKey,
      sessionToken: raw.sessionToken,
    };
  }
  throw new Error(
    "No AWS credentials: set AWS_* env vars or sign in via admin-web (which writes ~/.starkeep/cloud-credentials.json).",
  );
}

async function assume(arn: string, creds: Creds, sessionName: string, region: string): Promise<Creds> {
  const sts = new STSClient({ region, credentials: creds });
  const r = await sts.send(
    new AssumeRoleCommand({ RoleArn: arn, RoleSessionName: sessionName, DurationSeconds: 900 }),
  );
  const c = r.Credentials!;
  return { accessKeyId: c.AccessKeyId!, secretAccessKey: c.SecretAccessKey!, sessionToken: c.SessionToken! };
}

async function connectAsAdminWithRetry(
  hostname: string,
  region: string,
  creds: Creds,
): Promise<pg.Client> {
  let lastErr: unknown;
  for (let i = 0; i < 8; i++) {
    try {
      const signer = new DsqlSigner({ hostname, region, credentials: creds });
      const token = await signer.getDbConnectAdminAuthToken();
      const client = new pg.Client({
        host: hostname,
        port: 5432,
        database: "postgres",
        user: "admin",
        password: token,
        ssl: { rejectUnauthorized: true },
      });
      await client.connect();
      return client;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

interface ProbeResult {
  group: string;
  what: string;
  outcome: "ok" | "failed";
  result: string;
  sqlstate: string;
  surprise: string;
}

async function runProbes(client: pg.Client): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const probe of PROBES) {
    try {
      const r = await client.query(probe.sql);
      const row = r.rows[0] ?? {};
      const rendered = Object.values(row)
        .map((v) => (v === null ? "NULL" : String(v)))
        .join(" | ");
      results.push({
        group: probe.group,
        what: probe.what,
        outcome: "ok",
        result: rendered.slice(0, 40),
        sqlstate: "",
        surprise: probe.expect === "unsupported" ? "EXPECTED FAILURE" : "",
      });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      results.push({
        group: probe.group,
        what: probe.what,
        outcome: "failed",
        result: (e.message ?? "").split("\n")[0]!.slice(0, 40),
        sqlstate: e.code ?? "",
        surprise: probe.expect === "supported" ? "EXPECTED SUCCESS" : "",
      });
    }
  }
  return results;
}

/**
 * Whether a `tsvector` column can be stored and indexed.
 *
 * Expression probes answer neither question: the runtime type existing says
 * nothing about whether `CREATE TABLE` accepts it, and Postgres full-text
 * search is only useful with a GIN or GiST index, neither of which DSQL's
 * documented `CREATE INDEX ASYNC` surface mentions.
 *
 * Writes, so it runs only under `--ddl`. One uniquely-named table, dropped in
 * the finally block. DSQL allows one DDL statement per transaction and requires
 * DDL and DML in separate transactions, so every statement goes on its own.
 */
async function runStorageProbes(client: pg.Client): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  const created: string[] = [];

  const step = async (what: string, sql: string, expect: Probe["expect"]) => {
    try {
      const r = await client.query(sql);
      const row = r.rows[0] ?? {};
      results.push({
        group: "storage",
        what,
        outcome: "ok",
        result: Object.values(row).map(String).join(" | ").slice(0, 40),
        sqlstate: "",
        surprise: expect === "unsupported" ? "EXPECTED FAILURE" : "",
      });
      return true;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      results.push({
        group: "storage",
        what,
        outcome: "failed",
        result: (e.message ?? "").split("\n")[0]!.slice(0, 40),
        sqlstate: e.code ?? "",
        surprise: expect === "supported" ? "EXPECTED SUCCESS" : "",
      });
      return false;
    }
  };

  /** Create one probe table, run `then` if it exists, and remember to drop it. */
  const withTable = async (
    suffix: string,
    columns: string,
    label: string,
    expect: Probe["expect"],
    then?: (table: string) => Promise<void>,
  ) => {
    const table = `public.starkeep_capprobe_${process.pid}_${suffix}`;
    const made = await step(label, `CREATE TABLE ${table} (${columns})`, expect);
    if (!made) return;
    created.push(table);
    if (then) await then(table);
  };

  try {
    // The type the search question turns on. Storable, or runtime-only?
    await withTable("tsv", "id int PRIMARY KEY, tsv tsvector", "tsvector column", "unknown");

    // An array column would allow one row per record with a token array, which
    // is the alternative shape to a row-per-token table — but only if arrays
    // are storable rather than runtime-only, and only if GIN exists to index one.
    await withTable("arr", "id int PRIMARY KEY, tags text[]", "text[] column", "unknown");

    // jsonb is a documented storage type, so this isolates the access method:
    // if GIN exists at all, it exists here.
    await withTable("gin", "id int PRIMARY KEY, doc jsonb", "jsonb column", "supported", async (t) => {
      await step(
        "GIN index (access method exists?)",
        `CREATE INDEX ASYNC idx_capprobe_gin_${process.pid} ON ${t} USING GIN (doc)`,
        "unknown",
      );
      await step(
        "GiST index (access method exists?)",
        `CREATE INDEX ASYNC idx_capprobe_gist_${process.pid} ON ${t} USING GIST (doc)`,
        "unknown",
      );
      await step(
        "expression index on a text column",
        `CREATE INDEX ASYNC idx_capprobe_expr_${process.pid} ON ${t} ((doc->>'k'))`,
        "unknown",
      );
    });

    await step(
      "available index access methods",
      `SELECT coalesce(string_agg(amname, ','), '(none)') FROM pg_am`,
      "unknown",
    );

    // Two claims in this codebase contradict each other. `dsql-schema-init.ts`
    // states that DSQL does not accept `IF NOT EXISTS` on the async index form
    // and pre-checks `pg_indexes` instead; `dsql-ddl.ts` has been emitting
    // `CREATE INDEX ASYNC IF NOT EXISTS` since 2026-05-18. Settle which is
    // right, and separately answer the two `ALTER TABLE` questions the
    // metadata `record_type` backfill turns on.
    await withTable(
      "idx",
      "id int PRIMARY KEY, k text",
      "probe table for index and ALTER probes",
      "supported",
      async (t) => {
        const name = `idx_capprobe_ine_${process.pid}`;
        await step(
          "CREATE INDEX IF NOT EXISTS (synchronous form)",
          `CREATE INDEX IF NOT EXISTS ${name}_sync ON ${t} (k)`,
          "unknown",
        );
        await step(
          "CREATE INDEX ASYNC IF NOT EXISTS (first time)",
          `CREATE INDEX ASYNC IF NOT EXISTS ${name} ON ${t} (k)`,
          "unknown",
        );
        // The index is built asynchronously, so give it a moment to appear in
        // the catalog before asking whether the guard actually suppresses the
        // duplicate.
        await new Promise((r) => setTimeout(r, 5000));
        await step(
          "CREATE INDEX ASYNC IF NOT EXISTS (index already exists)",
          `CREATE INDEX ASYNC IF NOT EXISTS ${name} ON ${t} (k)`,
          "unknown",
        );
        await step(
          "CREATE INDEX ASYNC without the guard (index already exists)",
          `CREATE INDEX ASYNC ${name} ON ${t} (k)`,
          "unsupported",
        );
        await step(
          "ALTER TABLE ADD COLUMN",
          `ALTER TABLE ${t} ADD COLUMN record_type text`,
          "unknown",
        );
        await step(
          "ALTER TABLE ALTER COLUMN SET NOT NULL",
          `ALTER TABLE ${t} ALTER COLUMN record_type SET NOT NULL`,
          "unknown",
        );
      },
    );
  } finally {
    for (const table of created) {
      await client.query(`DROP TABLE IF EXISTS ${table}`).catch((err) => {
        console.warn(`failed to drop ${table} — drop it by hand:`, err);
      });
    }
  }
  return results;
}

async function main(): Promise<void> {
  const withDdl = process.argv.slice(2).includes("--ddl");
  const cfg = loadStarkeepConfig();
  const region = cfg.region ?? "us-east-2";
  const base = loadBaseCreds();

  const sessionTag = `cap-${process.pid}`;
  const mgr = await assume(cfg.managerRoleArn, base, `${sessionTag}-mgr`, region);

  const iam = new IAMClient({ region, credentials: mgr });
  const roleName = `${cfg.stackPrefix}-install-ddl-role`;
  const policyName = `temp-install-ddl-cap-${sessionTag}`;
  const policyDoc = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: ["dsql:DbConnectAdmin", "dsql:DbConnect"], Resource: "*" },
    ],
  });

  await iam.send(
    new PutRolePolicyCommand({ RoleName: roleName, PolicyName: policyName, PolicyDocument: policyDoc }),
  );

  let exitCode = 0;
  try {
    // IAM propagation to the DSQL data-plane authorizer is tens of seconds.
    await new Promise((r) => setTimeout(r, 12_000));
    const ddl = await assume(
      `arn:aws:iam::${cfg.accountId}:role/${roleName}`,
      mgr,
      `${sessionTag}-ddl`,
      region,
    );
    const client = await connectAsAdminWithRetry(cfg.auroraEndpoint, region, ddl);
    try {
      const version = await client.query("SELECT version()");
      console.log(`\n${version.rows[0]?.version ?? "(unknown version)"}\n`);
      const results = await runProbes(client);
      if (withDdl) results.push(...(await runStorageProbes(client)));
      else console.log("(pass --ddl to also probe tsvector storage and indexing)\n");
      for (const group of ["regex", "pattern", "fts", "aggregate", "storage"]) {
        const rows = results.filter((r) => r.group === group);
        if (rows.length === 0) continue;
        console.log(`\n=== ${group} ===`);
        console.table(rows);
      }
      const surprises = results.filter((r) => r.surprise !== "");
      if (surprises.length > 0) {
        console.log("\n=== probes that contradicted the plan's assumption ===");
        console.table(surprises);
      }
    } finally {
      await client.end();
    }
  } catch (err) {
    console.error("error:", err);
    exitCode = 1;
  } finally {
    await iam
      .send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }))
      .catch((err) => console.warn("failed to detach temp policy:", err));
  }
  process.exit(exitCode);
}

main();
