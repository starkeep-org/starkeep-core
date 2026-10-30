/**
 * Every statement a user-scoped DSQL connection compiles reads and writes one
 * user's rows, and no route has to remember to ask.
 *
 * DSQL has no row-level security, so the cut between users is in the
 * application layer. Spread over every route, the cut would be one forgotten
 * `where` away from another user's library. Here it is one Kysely plugin,
 * applied to the compiler a user-scoped adapter builds with:
 *
 * - **Reads, updates and deletes** of an owned table gain
 *   `<table>.user_id = <user>`: in the `where` for a table in `from`, and in
 *   the `on` for a joined one, so a left join stays a left join.
 * - **Inserts** into an owned table set `user_id` to the user, overriding any
 *   value the row carried, so a row from the wire cannot name its own owner.
 *   An `insert … select` selects the user in the owner column's place. An
 *   `on conflict` target gains `user_id`, because every owned table's primary
 *   key starts with it.
 * - **Updates** never change `user_id`: a `set` of it is dropped.
 *
 * Kysely runs plugins when a query compiles, so the compile-only instance this
 * package builds with applies it with no executor. Nested queries go through
 * the same transform, including those inside `sql` templates. What it cannot
 * see is a table named in raw SQL text; no code path does that today, and
 * {@link assertOwnerScoped} is the tripwire for one that starts to.
 *
 * Owned tables: `shared.records`, `shared.record_labels`,
 * `shared.object_availability`, the two `shared.node_watermarks_*` tables,
 * every `shared.record_<category>_metadata`, and every table in an app's
 * `app_<appId>` schema. The registry, the grants and
 * the label-key declarations belong to the deployment and stay unscoped.
 *
 * See `~/projects/starkeep/plan-multi-user-roles-2026-10-16.md`, steps 4.2–4.4.
 */

import {
  AliasNode,
  AndNode,
  ParensNode,
  BinaryOperationNode,
  ColumnNode,
  IdentifierNode,
  InsertQueryNode,
  OnConflictNode,
  OnNode,
  OperationNodeTransformer,
  OperatorNode,
  PrimitiveValueListNode,
  ReferenceNode,
  SelectQueryNode,
  SelectionNode,
  TableNode,
  ValueListNode,
  ValueNode,
  ValuesNode,
  WhereNode,
  type DeleteQueryNode,
  type JoinNode,
  type KyselyPlugin,
  type OperationNode,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryId,
  type QueryResult,
  type RootOperationNode,
  type UnknownRow,
  type UpdateQueryNode,
} from "kysely";
import { OWNER_COLUMN, USER_SEGMENT_PATTERN } from "@starkeep/protocol-primitives";

export { OWNER_COLUMN };

const OWNED_SHARED_TABLES = new Set([
  "records",
  "record_labels",
  "object_availability",
  "node_watermarks_records",
  "node_watermarks_labels",
]);

/** Whether `schema.table` holds one user's rows. */
export function isOwnedTable(schema: string | undefined, table: string): boolean {
  if (schema === "shared")
    return OWNED_SHARED_TABLES.has(table) || /^record_[a-z0-9_]+_metadata$/.test(table);
  return schema !== undefined && schema.startsWith("app_");
}

/** An owned table as a statement names it: the table, and the name its columns are qualified by. */
interface OwnedSource {
  readonly qualifier: TableNode;
}

function ownedSource(node: OperationNode): OwnedSource | null {
  if (TableNode.is(node)) {
    const { schema, identifier } = node.table;
    return isOwnedTable(schema?.name, identifier.name) ? { qualifier: node } : null;
  }
  if (AliasNode.is(node) && TableNode.is(node.node)) {
    const { schema, identifier } = node.node.table;
    if (!isOwnedTable(schema?.name, identifier.name)) return null;
    const alias = IdentifierNode.is(node.alias) ? node.alias.name : null;
    if (alias === null)
      throw new Error("owner scope: an owned table aliased by something other than a name");
    return { qualifier: TableNode.create(alias) };
  }
  return null;
}

function ownerPredicate(source: OwnedSource, userId: string): OperationNode {
  return BinaryOperationNode.create(
    ReferenceNode.create(ColumnNode.create(OWNER_COLUMN), source.qualifier),
    OperatorNode.create("="),
    ValueNode.create(userId),
  );
}

/** The name a qualifier compiles to, `schema.table` or the alias. */
function qualifierName(qualifier: TableNode): string {
  const { schema, identifier } = qualifier.table;
  return schema ? `${schema.name}.${identifier.name}` : identifier.name;
}

/**
 * Whether the predicate `node` already requires `qualifier`'s owner to be
 * `userId`: the owner predicate is one of its top-level `and` conjuncts, with
 * this user's value. A query built with a scoped compiler and nested in
 * another is transformed again by the outer compile; this keeps it from
 * gaining the predicate twice. Anything weaker — under an `or`, or with
 * another value — does not count, so the predicate is added.
 */
function holdsOwnerPredicate(
  node: OperationNode | undefined,
  qualifier: TableNode,
  userId: string,
): boolean {
  if (!node) return false;
  if (AndNode.is(node)) {
    return (
      holdsOwnerPredicate(node.left, qualifier, userId) ||
      holdsOwnerPredicate(node.right, qualifier, userId)
    );
  }
  if (ParensNode.is(node)) return holdsOwnerPredicate(node.node, qualifier, userId);
  if (!BinaryOperationNode.is(node)) return false;
  const { leftOperand: left, operator, rightOperand: right } = node;
  return (
    ReferenceNode.is(left) &&
    ColumnNode.is(left.column) &&
    left.column.column.name === OWNER_COLUMN &&
    left.table !== undefined &&
    qualifierName(left.table) === qualifierName(qualifier) &&
    OperatorNode.is(operator) &&
    operator.operator === "=" &&
    ValueNode.is(right) &&
    right.value === userId
  );
}

function andWhere(where: WhereNode | undefined, predicate: OperationNode): WhereNode {
  return where
    ? WhereNode.cloneWithOperation(where, "And", predicate)
    : WhereNode.create(predicate);
}

function isOwnerColumn(node: OperationNode): boolean {
  return ColumnNode.is(node) && node.column.name === OWNER_COLUMN;
}

class OwnerScopeTransformer extends OperationNodeTransformer {
  constructor(private readonly userId: string) {
    super();
  }

  /** Scope each owned join in its `on`, and return the predicates for owned cross joins. */
  private scopeJoins(joins: ReadonlyArray<JoinNode> | undefined): {
    joins: ReadonlyArray<JoinNode> | undefined;
    wherePredicates: OperationNode[];
  } {
    const wherePredicates: OperationNode[] = [];
    if (!joins) return { joins, wherePredicates };
    const scoped = joins.map((join) => {
      const source = ownedSource(join.table);
      if (!source || holdsOwnerPredicate(join.on?.on, source.qualifier, this.userId)) return join;
      const predicate = ownerPredicate(source, this.userId);
      if (!join.on) {
        wherePredicates.push(predicate);
        return join;
      }
      return { ...join, on: OnNode.cloneWithOperation(join.on, "And", predicate) };
    });
    return { joins: scoped, wherePredicates };
  }

  private scopeSources(
    sources: ReadonlyArray<OperationNode>,
    where: WhereNode | undefined,
  ): OperationNode[] {
    return sources.flatMap((node) => {
      const source = ownedSource(node);
      if (!source || holdsOwnerPredicate(where?.where, source.qualifier, this.userId)) return [];
      return [ownerPredicate(source, this.userId)];
    });
  }

  protected override transformSelectQuery(
    node: SelectQueryNode,
    queryId?: QueryId,
  ): SelectQueryNode {
    const inner = super.transformSelectQuery(node, queryId);
    const { joins, wherePredicates } = this.scopeJoins(inner.joins);
    let where = inner.where;
    for (const predicate of [
      ...this.scopeSources(inner.from?.froms ?? [], inner.where),
      ...wherePredicates,
    ]) {
      where = andWhere(where, predicate);
    }
    return { ...inner, ...(joins ? { joins } : {}), ...(where ? { where } : {}) };
  }

  protected override transformUpdateQuery(
    node: UpdateQueryNode,
    queryId?: QueryId,
  ): UpdateQueryNode {
    const inner = super.transformUpdateQuery(node, queryId);
    const { joins, wherePredicates } = this.scopeJoins(inner.joins);
    const targets = inner.table ? [inner.table] : [];
    let where = inner.where;
    for (const predicate of [
      ...this.scopeSources(targets, inner.where),
      ...this.scopeSources(inner.from?.froms ?? [], inner.where),
      ...wherePredicates,
    ]) {
      where = andWhere(where, predicate);
    }
    const ownsTarget = targets.some((t) => ownedSource(t) !== null);
    const updates = ownsTarget
      ? inner.updates?.filter((u) => !isOwnerColumn(u.column))
      : inner.updates;
    return {
      ...inner,
      ...(joins ? { joins } : {}),
      ...(where ? { where } : {}),
      ...(updates ? { updates } : {}),
    };
  }

  protected override transformDeleteQuery(
    node: DeleteQueryNode,
    queryId?: QueryId,
  ): DeleteQueryNode {
    const inner = super.transformDeleteQuery(node, queryId);
    const { joins, wherePredicates } = this.scopeJoins(inner.joins);
    let where = inner.where;
    for (const predicate of [
      ...this.scopeSources(inner.from.froms, inner.where),
      ...this.scopeSources(inner.using?.tables ?? [], inner.where),
      ...wherePredicates,
    ]) {
      where = andWhere(where, predicate);
    }
    return { ...inner, ...(joins ? { joins } : {}), ...(where ? { where } : {}) };
  }

  protected override transformInsertQuery(
    node: InsertQueryNode,
    queryId?: QueryId,
  ): InsertQueryNode {
    const inner = super.transformInsertQuery(node, queryId);
    if (!inner.into || !ownedSource(inner.into)) return inner;
    if (inner.columns && inner.values && SelectQueryNode.is(inner.values)) {
      return { ...inner, ...this.scopeInsertSelect(inner.columns, inner.values, inner.onConflict) };
    }
    if (!inner.columns || !inner.values || !ValuesNode.is(inner.values)) {
      throw new Error(
        "owner scope: an insert into an owned table must list its columns and values",
      );
    }
    const at = inner.columns.findIndex(isOwnerColumn);
    const columns = at === -1 ? [...inner.columns, ColumnNode.create(OWNER_COLUMN)] : inner.columns;
    const rows = inner.values.values.map((row) => {
      if (PrimitiveValueListNode.is(row)) {
        const values = [...row.values];
        if (at === -1) values.push(this.userId);
        else values[at] = this.userId;
        return PrimitiveValueListNode.create(values);
      }
      const values = [...row.values];
      if (at === -1) values.push(ValueNode.create(this.userId));
      else values[at] = ValueNode.create(this.userId);
      return ValueListNode.create(values);
    });
    const onConflict = scopeOnConflict(inner.onConflict);
    return {
      ...inner,
      columns,
      values: ValuesNode.create(rows),
      ...(onConflict ? { onConflict } : {}),
    };
  }

  /**
   * An `insert … select` into an owned table: the select names the owner
   * column's value, and selects the user there whatever it named. The select
   * itself was scoped on the way in, so it reads only the user's rows.
   */
  private scopeInsertSelect(
    columns: ReadonlyArray<ColumnNode>,
    select: SelectQueryNode,
    onConflict: OnConflictNode | undefined,
  ): Pick<InsertQueryNode, "columns" | "values" | "onConflict"> {
    const at = columns.findIndex(isOwnerColumn);
    const selections = select.selections ?? [];
    if (at === -1 || selections.length !== columns.length) {
      throw new Error(
        "owner scope: an insert … select into an owned table must list the owner column and select one value per column",
      );
    }
    const owner = SelectionNode.create(
      AliasNode.create(ValueNode.create(this.userId), IdentifierNode.create(OWNER_COLUMN)),
    );
    const scoped = scopeOnConflict(onConflict);
    const values: SelectQueryNode = {
      ...select,
      selections: selections.map((s, i) => (i === at ? owner : s)),
    };
    return {
      columns,
      values,
      ...(scoped ? { onConflict: scoped } : {}),
    };
  }
}

/**
 * An upsert's conflict clause on an owned table: the target gains the owner,
 * and the update never sets it.
 */
function scopeOnConflict(onConflict: OnConflictNode | undefined): OnConflictNode | undefined {
  if (!onConflict) return undefined;
  if (onConflict.constraint || onConflict.indexExpression) {
    throw new Error("owner scope: an upsert into an owned table must name its conflict columns");
  }
  let scoped = onConflict;
  // A `do nothing` with no target conflicts on any key, which already
  // includes the owner.
  if (scoped.columns && !scoped.columns.some(isOwnerColumn)) {
    scoped = OnConflictNode.cloneWith(scoped, {
      columns: [ColumnNode.create(OWNER_COLUMN), ...scoped.columns],
    });
  }
  if (scoped.updates) {
    scoped = OnConflictNode.cloneWith(scoped, {
      updates: scoped.updates.filter((u) => !isOwnerColumn(u.column)),
    });
  }
  return scoped;
}

/**
 * The plugin that scopes every statement to `userId`. Give it to
 * `compiler.withPlugin(...)`; see {@link ownerScopedCompiler}.
 */
export class OwnerScopePlugin implements KyselyPlugin {
  private readonly transformer: OwnerScopeTransformer;

  constructor(readonly userId: string) {
    if (!USER_SEGMENT_PATTERN.test(userId)) {
      throw new Error(`owner scope: invalid user ${JSON.stringify(userId)}`);
    }
    this.transformer = new OwnerScopeTransformer(userId);
  }

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return this.transformer.transformNode(args.node, args.queryId);
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return args.result;
  }
}

/** Matches an owned table as compiled SQL names it, quoted. */
const OWNED_TABLE_SQL =
  /"shared"\."(records|record_labels|object_availability|node_watermarks_records|node_watermarks_labels|record_[a-z0-9_]+_metadata)"|"app_[a-z0-9_]+"\."[^"]+"/;

/**
 * Refuse a statement that names an owned table and never mentions the owner
 * column. Every statement the plugin compiled against an owned table does, so
 * a statement that does not was compiled around it — by the unscoped compiler,
 * or as raw text. A cheap tripwire, not the cut itself: the plugin is the cut.
 */
export function assertOwnerScoped(text: string): void {
  if (OWNED_TABLE_SQL.test(text) && !text.includes(`"${OWNER_COLUMN}"`)) {
    throw new Error(`unscoped statement against an owned table: ${text.slice(0, 200)}`);
  }
}

/** Strip the owner column from rows read back, so it never leaves the cloud. */
export function withoutOwner<T extends Record<string, unknown>>(
  row: T,
): Omit<T, typeof OWNER_COLUMN> {
  if (!(OWNER_COLUMN in row)) return row;
  const { [OWNER_COLUMN]: _owner, ...rest } = row;
  return rest;
}
