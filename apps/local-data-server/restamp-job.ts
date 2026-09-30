import type { DatabaseAdapter, RawDatabase } from "@starkeep/storage-adapter";
import {
  TYPES,
  isStandInCategory,
  typeCategory,
  type DataRecord,
  type HLCClock,
  type StandInCategory,
  type StandInStandards,
} from "@starkeep/protocol-primitives";
import { sqliteCompiler as qb } from "@starkeep/storage-sqlite";
import {
  originalsToRestamp,
  pageOriginals,
  restampOriginal,
} from "../../packages/shared-space-api/src/stand-ins/restamp.js";

/**
 * "Replace existing canonical stand-ins": the job that restamps every existing
 * original of the chosen categories with the library's new threshold.
 *
 * A job rather than a request, because a library holds tens of thousands of
 * originals and each restamp is a few writes. It walks the originals a page at
 * a time and keeps its cursor in a local table, so a restart resumes where it
 * stopped rather than beginning again. The standards it restamps to are saved
 * with it: a later change of the setting starts a new job rather than moving
 * the target of a running one.
 *
 * The rows it writes sync like any other write. Apps take it from there: the
 * summary marks each outdated canonical stand-in, and the app that made it
 * derives the replacement. See `stand-ins/restamp.ts` in shared-space-api.
 */

const PAGE_SIZE = 200;

export interface RestampJobStatus {
  readonly running: boolean;
  readonly categories: readonly StandInCategory[];
  /** Originals the job will restamp, counted when it started. */
  readonly total: number;
  readonly restamped: number;
  /** Originals whose smaller stand-in became the canonical one. */
  readonly promoted: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface RestampJob {
  /** Start a job, replacing any earlier one, and run it in the background. */
  start(categories: readonly StandInCategory[], standards: StandInStandards): Promise<RestampJobStatus>;
  /** Run an unfinished job left by an earlier process. */
  resume(): void;
  status(): RestampJobStatus | null;
  /** Resolves when the running job, if any, has finished or stopped. */
  settled(): Promise<void>;
}

interface JobRow {
  categories_json: string;
  standards_json: string;
  cursor: string | null;
  total: number;
  restamped: number;
  promoted: number;
  started_at: string;
  finished_at: string | null;
}

export function createRestampJob(options: {
  readonly db: RawDatabase;
  readonly databaseAdapter: DatabaseAdapter;
  readonly clock: HLCClock;
  /** Called with each page's writes, so sync ships them without waiting for a tick. */
  readonly onWritten: (records: readonly DataRecord[]) => void;
}): RestampJob {
  const { db, databaseAdapter, clock, onWritten } = options;

  db.exec(
    qb.schema
      .createTable("library_restamp_job")
      .ifNotExists()
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("categories_json", "text", (c) => c.notNull())
      .addColumn("standards_json", "text", (c) => c.notNull())
      .addColumn("cursor", "text")
      .addColumn("total", "integer", (c) => c.notNull())
      .addColumn("restamped", "integer", (c) => c.notNull())
      .addColumn("promoted", "integer", (c) => c.notNull())
      .addColumn("started_at", "text", (c) => c.notNull())
      .addColumn("finished_at", "text")
      .compile().sql,
  );

  let running: Promise<void> | null = null;

  function read(): JobRow | null {
    const query = qb.selectFrom("library_restamp_job").selectAll().where("id", "=", "current").compile();
    return (db.prepare(query.sql).get(...(query.parameters as string[])) as JobRow | undefined) ?? null;
  }

  function write(row: JobRow): void {
    const query = qb
      .insertInto("library_restamp_job")
      .values({ id: "current", ...row })
      .onConflict((oc) => oc.column("id").doUpdateSet({ ...row }))
      .compile();
    db.prepare(query.sql).run(...(query.parameters as Array<string | number | null>));
  }

  function typesOf(categories: readonly StandInCategory[]): string[] {
    return TYPES.map((t) => t.id).filter((id) => {
      const category = typeCategory(id);
      return isStandInCategory(category) && categories.includes(category);
    });
  }

  async function run(): Promise<void> {
    let row = read();
    while (row && row.finished_at === null) {
      const types = typesOf(JSON.parse(row.categories_json) as StandInCategory[]);
      const standards = JSON.parse(row.standards_json) as StandInStandards;
      const page = await pageOriginals(databaseAdapter, types, row.cursor, PAGE_SIZE);
      const written: DataRecord[] = [];
      let restamped = 0;
      let promoted = 0;
      for (const original of page.records) {
        const result = await restampOriginal(databaseAdapter, original, standards, clock);
        if (result.written.length === 0) continue;
        restamped += 1;
        if (result.promoted) promoted += 1;
        written.push(...result.written);
      }
      row = {
        ...row,
        cursor: page.nextCursor,
        restamped: row.restamped + restamped,
        promoted: row.promoted + promoted,
        finished_at: page.nextCursor === null ? new Date().toISOString() : null,
      };
      write(row);
      if (written.length > 0) onWritten(written);
    }
  }

  function launch(): void {
    if (running) return;
    running = run()
      .catch((err) => console.warn("[restamp] the replacement job stopped:", err))
      .finally(() => {
        running = null;
      });
  }

  function statusOf(row: JobRow | null): RestampJobStatus | null {
    if (!row) return null;
    return {
      running: row.finished_at === null,
      categories: JSON.parse(row.categories_json) as StandInCategory[],
      total: row.total,
      restamped: row.restamped,
      promoted: row.promoted,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    };
  }

  return {
    async start(categories, standards) {
      await running;
      let total = 0;
      const toRestamp = originalsToRestamp(databaseAdapter, standards, typesOf(categories));
      while (!(await toRestamp.next()).done) total += 1;
      write({
        categories_json: JSON.stringify(categories),
        standards_json: JSON.stringify(standards),
        cursor: null,
        total,
        restamped: 0,
        promoted: 0,
        started_at: new Date().toISOString(),
        finished_at: null,
      });
      launch();
      return statusOf(read())!;
    },
    resume() {
      if (read()?.finished_at === null) launch();
    },
    status: () => statusOf(read()),
    settled: async () => {
      await running;
    },
  };
}
