/**
 * A view of one user's shared records narrowed to the types an app may read.
 *
 * A mobile app syncs through the Drive channel, whose exchange carries every
 * shared type, but may reach only the types its manifest grants. Filtering the
 * exchange's answer after the fact would not do: the exchange also reports
 * coverage watermarks and digests, and a watermark or digest computed over
 * rows the phone never receives would make the two sides disagree forever.
 * Every read the exchange makes must see the same narrowed library.
 *
 * So the narrowing is a Kysely plugin on the adapter's compiler, as the owner
 * scope is, and every statement compiled through it sees only:
 *
 * - `shared.records` rows whose `type` is in the scope;
 * - `shared.record_labels` rows whose `record_type` is;
 * - the watermark entries for those rows, in `shared.node_watermarks_records`
 *   by `type` and in `shared.node_watermarks_labels` by `record_type`. Each
 *   entry is keyed by the same column as its source table, so the narrowed
 *   coverage is exactly the coverage of the narrowed rows.
 *
 * Labels narrow on their own `record_type` rather than on a semi-join back to
 * records. The column is denormalized from `records.type`, which is immutable,
 * so it cannot go stale, and read gating on `idx_record_labels_reverse` already
 * relies on it. The semi-join cost a phone's grouped label read 0.20 DPU on
 * DSQL against 0.08 for the column. One difference: an orphan label, whose
 * record is gone, is in scope when its type is. The schema tolerates orphans.
 *
 * Reads, updates and deletes gain the predicate. Inserts pass through
 * unchanged: what a scoped caller may write is checked before the write, by
 * the caller, which can refuse a push whole rather than drop rows from it.
 */

import {
  AliasNode,
  BinaryOperationNode,
  ColumnNode,
  IdentifierNode,
  OperationNodeTransformer,
  OperatorNode,
  PrimitiveValueListNode,
  ReferenceNode,
  TableNode,
  ValueNode,
  WhereNode,
  type DeleteQueryNode,
  type KyselyPlugin,
  type OperationNode,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryId,
  type QueryResult,
  type RootOperationNode,
  type SelectQueryNode,
  type UnknownRow,
  type UpdateQueryNode,
} from "kysely";

const SHARED = "shared";

/** The scoped tables, by the kind of row each holds or describes. */
const SCOPED_TABLES: ReadonlyMap<string, Scoped> = new Map([
  ["records", "records"],
  ["record_labels", "labels"],
  ["node_watermarks_records", "records"],
  ["node_watermarks_labels", "labels"],
]);

type Scoped = "records" | "labels";

/** The scoped table a source names, and the name its columns are qualified by. */
function scopedSource(node: OperationNode): { kind: Scoped; qualifier: TableNode } | null {
  const kindOf = (table: TableNode): Scoped | null => {
    if (table.table.schema?.name !== SHARED) return null;
    return SCOPED_TABLES.get(table.table.identifier.name) ?? null;
  };
  if (TableNode.is(node)) {
    const kind = kindOf(node);
    return kind ? { kind, qualifier: node } : null;
  }
  if (AliasNode.is(node) && TableNode.is(node.node)) {
    const kind = kindOf(node.node);
    if (!kind) return null;
    if (!IdentifierNode.is(node.alias)) {
      throw new Error("type scope: a scoped table aliased by something other than a name");
    }
    return { kind, qualifier: TableNode.create(node.alias.name) };
  }
  return null;
}

/** `<qualifier>.<column> IN (...)`, or a predicate no row satisfies for an empty scope. */
function typeIn(qualifier: TableNode, column: string, types: readonly string[]): OperationNode {
  if (types.length === 0) {
    return BinaryOperationNode.create(
      ValueNode.createImmediate(1),
      OperatorNode.create("="),
      ValueNode.createImmediate(0),
    );
  }
  return BinaryOperationNode.create(
    ReferenceNode.create(ColumnNode.create(column), qualifier),
    OperatorNode.create("in"),
    PrimitiveValueListNode.create([...types]),
  );
}

function andWhere(where: WhereNode | undefined, predicate: OperationNode): WhereNode {
  return where
    ? WhereNode.cloneWithOperation(where, "And", predicate)
    : WhereNode.create(predicate);
}

class TypeScopeTransformer extends OperationNodeTransformer {
  constructor(private readonly types: readonly string[]) {
    super();
  }

  private predicates(sources: ReadonlyArray<OperationNode>): OperationNode[] {
    return sources.flatMap((node) => {
      const source = scopedSource(node);
      if (!source) return [];
      return [
        typeIn(source.qualifier, source.kind === "records" ? "type" : "record_type", this.types),
      ];
    });
  }

  private refuseScopedJoins(joins: ReadonlyArray<{ table: OperationNode }> | undefined): void {
    // No exchange path joins either table today. A join would need its
    // predicate in the `on`, as the owner scope does it; until one exists,
    // refusing beats compiling an unscoped read.
    if (joins?.some((join) => scopedSource(join.table) !== null)) {
      throw new Error("type scope: a join on records or labels is not supported");
    }
  }

  protected override transformSelectQuery(
    node: SelectQueryNode,
    queryId?: QueryId,
  ): SelectQueryNode {
    const inner = super.transformSelectQuery(node, queryId);
    this.refuseScopedJoins(inner.joins);
    let where = inner.where;
    for (const predicate of this.predicates(inner.from?.froms ?? [])) {
      where = andWhere(where, predicate);
    }
    return where ? { ...inner, where } : inner;
  }

  protected override transformUpdateQuery(
    node: UpdateQueryNode,
    queryId?: QueryId,
  ): UpdateQueryNode {
    const inner = super.transformUpdateQuery(node, queryId);
    this.refuseScopedJoins(inner.joins);
    let where = inner.where;
    for (const predicate of this.predicates([
      ...(inner.table ? [inner.table] : []),
      ...(inner.from?.froms ?? []),
    ])) {
      where = andWhere(where, predicate);
    }
    return where ? { ...inner, where } : inner;
  }

  protected override transformDeleteQuery(
    node: DeleteQueryNode,
    queryId?: QueryId,
  ): DeleteQueryNode {
    const inner = super.transformDeleteQuery(node, queryId);
    this.refuseScopedJoins(inner.joins);
    let where = inner.where;
    for (const predicate of this.predicates([
      ...inner.from.froms,
      ...(inner.using?.tables ?? []),
    ])) {
      where = andWhere(where, predicate);
    }
    return where ? { ...inner, where } : inner;
  }
}

/**
 * The plugin that narrows records and labels to `types`. It adds no subquery,
 * so its order relative to the owner scope does not matter.
 */
export class RecordTypeScopePlugin implements KyselyPlugin {
  private readonly transformer: TypeScopeTransformer;

  constructor(readonly types: readonly string[]) {
    this.transformer = new TypeScopeTransformer([...new Set(types)].sort());
  }

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return this.transformer.transformNode(args.node, args.queryId);
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return args.result;
  }
}
