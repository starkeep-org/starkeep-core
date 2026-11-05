/**
 * The admin-web switch for Starkeep Drive's public-link capability.
 *
 * Drive's manifest cannot declare the capability, so this route is the only
 * writer of Drive's `public_sharing.app_capabilities` row. The cases pin that
 * it writes and deletes that one row and nothing else, and that a read
 * changes nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = new Set<string>();
const statements: Array<{ sql: string; params: unknown[] }> = [];

vi.mock("../src/lib/installer-dsql", async () => {
  const { Kysely, PostgresAdapter, DummyDriver, PostgresIntrospector, PostgresQueryCompiler } =
    await import("kysely");
  const compiler = new Kysely<Record<string, Record<string, unknown>>>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return {
    compiler,
    openInstallerPool: async (req: Request) => ({
      body: (await req.json()) as Record<string, unknown>,
      pool: {
        async query(sql: string, params: unknown[]) {
          statements.push({ sql, params });
          if (sql.startsWith("insert")) rows.add(params[0] as string);
          if (sql.startsWith("delete")) rows.delete(params[0] as string);
          return { rows: sql.startsWith("select") ? [...rows].map((app_id) => ({ app_id })) : [] };
        },
        async end() {},
      },
    }),
  };
});

const { driveCapability } = await import("../src/routes/public-shares");

function post(body: Record<string, unknown>) {
  return driveCapability(
    new Request("http://localhost/api/public-shares/drive-capability", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  rows.clear();
  statements.length = 0;
});

describe("the Drive public-link switch", () => {
  it("starts off and reads without writing", async () => {
    expect(await (await post({})).json()).toEqual({ enabled: false });
    expect(statements.every((s) => s.sql.startsWith("select"))).toBe(true);
  });

  it("turns on and off by writing Drive's row only", async () => {
    expect(await (await post({ enabled: true })).json()).toEqual({ enabled: true });
    expect([...rows]).toEqual(["starkeep-drive"]);
    expect(await (await post({ enabled: false })).json()).toEqual({ enabled: false });
    const writes = statements.filter((s) => !s.sql.startsWith("select"));
    expect(writes.map((s) => s.params)).toEqual([["starkeep-drive"], ["starkeep-drive"]]);
    expect(writes.every((s) => s.sql.includes('"public_sharing"."app_capabilities"'))).toBe(true);
  });

  it("refuses an enabled value that is not a boolean", async () => {
    expect((await post({ enabled: "yes" })).status).toBe(400);
    expect(statements).toEqual([]);
  });
});
