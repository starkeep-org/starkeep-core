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
 * - `shared.record_labels` rows whose record is.
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
  SelectQueryNode,
  SelectionNode,
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
  type UnknownRow,
  type UpdateQueryNode,
} from "kysely";

const RECORDS = { schema: "shared", table: "records" };
const LABELS = { schema: "shared", table: "record_labels" };

type Scoped = "records" | "labels";

/** The scoped table a source names, and the name its columns are qualified by. */
function scopedSource(node: OperationNode): { kind: Scoped; qualifier: TableNode } | null {
  const kindOf = (table: TableNode): Scoped | null => {
    const schema = table.table.schema?.name;
    const name = table.table.identifier.name;
    if (schema !== RECORDS.schema) return null;
    if (name === RECORDS.table) return "records";
    if (name === LABELS.table) return "labels";
    return null;
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

/** `<qualifier>.type IN (...)`, or a predicate no row satisfies for an empty scope. */
function typeIn(qualifier: TableNode | null, types: readonly string[]): OperationNode {
  if (types.length === 0) {
    return BinaryOperationNode.create(
      ValueNode.createImmediate(1),
      OperatorNode.create("="),
      ValueNode.createImmediate(0),
    );
  }
  const column = ColumnNode.create("type");
  return BinaryOperationNode.create(
    qualifier ? ReferenceNode.create(column, qualifier) : column,
    OperatorNode.create("in"),
    PrimitiveValueListNode.create([...types]),
  );
}

/**
 * `<labels>.record_id IN (SELECT id FROM shared.records WHERE type IN (...))`.
 * The subquery goes through the rest of the compiler's plugins, so the owner
 * scope narrows it to the same user.
 */
function labelRecordIn(qualifier: TableNode, types: readonly string[]): OperationNode {
  const records = TableNode.createWithSchema(RECORDS.schema, RECORDS.table);
  const subquery: SelectQueryNode = {
    ...SelectQueryNode.cloneWithSelections(SelectQueryNode.createFrom([records]), [
      SelectionNode.create(ReferenceNode.create(ColumnNode.create("id"), records)),
    ]),
    where: WhereNode.create(typeIn(records, types)),
  };
  return BinaryOperationNode.create(
    ReferenceNode.create(ColumnNode.create("record_id"), qualifier),
    OperatorNode.create("in"),
    subquery,
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
        source.kind === "records"
          ? typeIn(source.qualifier, this.types)
          : labelRecordIn(source.qualifier, this.types),
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
 * The plugin that narrows records and labels to `types`. Plugins run in the
 * order they were added, so add this one *before* the owner scope: the owner
 * scope then narrows the subquery this one adds, too.
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
