import { describe, expect, it } from "vitest";
import { sql } from "kysely";
import { compiler } from "../src/query-builder.js";
import { assertOwnerScoped, isOwnedTable, OwnerScopePlugin, withoutOwner } from "../src/owner-scope.js";

const USER = "user-a";
const qb = compiler.withPlugin(new OwnerScopePlugin(USER));

describe("which tables are owned", () => {
  it("owns the record, label, availability, metadata and app tables", () => {
    expect(isOwnedTable("shared", "records")).toBe(true);
    expect(isOwnedTable("shared", "record_labels")).toBe(true);
    expect(isOwnedTable("shared", "object_availability")).toBe(true);
    expect(isOwnedTable("shared", "record_image_metadata")).toBe(true);
    expect(isOwnedTable("app_memo", "cards")).toBe(true);
  });

  it("leaves the deployment's own tables alone", () => {
    expect(isOwnedTable("shared", "app_registry")).toBe(false);
    expect(isOwnedTable("shared", "access_grants")).toBe(false);
    expect(isOwnedTable("shared", "app_label_keys")).toBe(false);
    expect(isOwnedTable("shared", "app_syncable_namespaces")).toBe(false);
    expect(isOwnedTable(undefined, "records")).toBe(false);
  });
});

describe("reads", () => {
  it("adds the owner to a select's where", () => {
    const q = qb.selectFrom("shared.records").selectAll().where("id", "=", "r1").compile();
    expect(q.sql).toBe(
      'select * from "shared"."records" where "id" = $1 and "shared"."records"."user_id" = $2',
    );
    expect(q.parameters).toEqual(["r1", USER]);
  });

  it("adds it to a select with no where", () => {
    const q = qb.selectFrom("shared.records").select("node_id").groupBy("node_id").compile();
    expect(q.sql).toContain('where "shared"."records"."user_id" = $1');
  });

  it("qualifies by the alias when the table has one", () => {
    const q = qb.selectFrom("shared.records as r").select("r.id").compile();
    expect(q.sql).toContain('where "r"."user_id" = $1');
  });

  it("scopes a joined table in its on, so a left join stays a left join", () => {
    const q = qb
      .selectFrom("shared.records")
      .leftJoin("shared.record_labels", "shared.record_labels.record_id", "shared.records.id")
      .selectAll()
      .compile();
    expect(q.sql).toContain(
      'left join "shared"."record_labels" on "shared"."record_labels"."record_id" = "shared"."records"."id" and "shared"."record_labels"."user_id" = $1',
    );
    expect(q.sql).toContain('where "shared"."records"."user_id" = $2');
  });

  it("scopes a nested query, including one inside a sql template", () => {
    const inner = qb.selectFrom("shared.record_labels").select("record_id");
    const q = qb
      .selectFrom("shared.records")
      .selectAll()
      .where(sql<boolean>`id in (${inner})`)
      .compile();
    expect(q.sql.match(/"user_id"/g)).toHaveLength(2);
    expect(q.parameters).toEqual([USER, USER]);
  });

  it("still adds the owner when a hand-written one is weaker", () => {
    const either = qb
      .selectFrom("shared.records")
      .selectAll()
      .where((eb) => eb.or([eb("id", "=", "r1"), eb("shared.records.user_id", "=", USER)]))
      .compile();
    expect(either.sql).toMatch(/\) and "shared"\."records"\."user_id" = \$3$/);
    const another = qb.selectFrom("shared.records").selectAll().where("shared.records.user_id", "=", "user-b").compile();
    expect(another.parameters).toEqual(["user-b", USER]);
  });

  it("leaves an unowned table unscoped", () => {
    const q = qb.selectFrom("shared.app_registry").selectAll().compile();
    expect(q.sql).toBe('select * from "shared"."app_registry"');
  });
});

describe("writes", () => {
  it("stamps an insert and puts the owner first in the conflict target", () => {
    const q = qb
      .insertInto("shared.records")
      .values({ id: "r1", type: "image/jpeg" })
      .onConflict((oc) => oc.column("id").doUpdateSet((eb) => ({ type: eb.ref("excluded.type") })))
      .compile();
    expect(q.sql).toBe(
      'insert into "shared"."records" ("id", "type", "user_id") values ($1, $2, $3) ' +
        'on conflict ("user_id", "id") do update set "type" = "excluded"."type"',
    );
    expect(q.parameters).toEqual(["r1", "image/jpeg", USER]);
  });

  it("overrides an owner the row names itself", () => {
    const q = qb.insertInto("app_memo.cards").values([{ id: "c1", user_id: "user-b" }, { id: "c2", user_id: "user-b" }]).compile();
    expect(q.parameters).toEqual(["c1", USER, "c2", USER]);
  });

  it("scopes an update and never changes its owner", () => {
    const q = qb
      .updateTable("shared.records")
      .set({ deleted_at: "t", user_id: "user-b" })
      .where("id", "=", "r1")
      .compile();
    expect(q.sql).toBe(
      'update "shared"."records" set "deleted_at" = $1 where "id" = $2 and "shared"."records"."user_id" = $3',
    );
  });

  it("scopes a delete", () => {
    const q = qb.deleteFrom("shared.record_image_metadata").where("record_id", "=", "r1").compile();
    expect(q.sql).toContain('and "shared"."record_image_metadata"."user_id" = $2');
  });

  it("drops the owner from an upsert's update set", () => {
    const q = qb
      .insertInto("app_memo.cards")
      .values({ id: "c1", front: "x" })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet((eb) => ({ front: eb.ref("excluded.front"), user_id: eb.ref("excluded.user_id") })),
      )
      .compile();
    expect(q.sql).toContain('on conflict ("user_id", "id") do update set "front" = "excluded"."front"');
    expect(q.sql).not.toContain('"user_id" = "excluded"."user_id"');
  });
});

describe("the tripwire", () => {
  it("passes a statement the plugin scoped", () => {
    expect(() => assertOwnerScoped(qb.selectFrom("shared.records").selectAll().compile().sql)).not.toThrow();
  });

  it("refuses a statement compiled around it", () => {
    expect(() => assertOwnerScoped(compiler.selectFrom("shared.records").selectAll().compile().sql)).toThrow(
      /unscoped statement/,
    );
    expect(() => assertOwnerScoped(compiler.selectFrom("app_memo.cards").selectAll().compile().sql)).toThrow();
  });

  it("passes statements against the deployment's own tables", () => {
    expect(() => assertOwnerScoped(compiler.selectFrom("shared.access_grants").selectAll().compile().sql)).not.toThrow();
  });
});

describe("rows read back", () => {
  it("lose the owner column", () => {
    expect(withoutOwner({ id: "c1", user_id: USER })).toEqual({ id: "c1" });
  });
});
