import type { QueryAST } from "../../types/query";

export type QueryAccessPath = "primary-key" | "index" | "object-store";

export interface QueryPlanSummary {
  readonly storeName: string;
  readonly accessPath: QueryAccessPath;
  readonly indexName?: string;
  readonly usesKeyRange: boolean;
  readonly requiresPostFilter: boolean;
  readonly requiresPostSort: boolean;
  readonly sortField?: string;
  readonly sortDirection?: "asc" | "desc";
  readonly pagination: "cursor" | "materialize-and-slice";
  readonly projectionFields?: readonly string[];
}

export interface QueryPlan<T = unknown> {
  readonly ast: QueryAST<T>;
  readonly summary: QueryPlanSummary;
  readonly canUseNativeCount: boolean;
}

function isValidNonNegativeInteger(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

/**
 * Compile a mutable builder AST into an immutable execution snapshot. The planner is intentionally
 * conservative: it describes the access path selected by the builder and flags work that must
 * happen in JavaScript, rather than claiming optimizations it cannot guarantee.
 */
export function compileQueryPlan<T>(source: QueryAST<T>): QueryPlan<T> {
  if (!source.storeName || typeof source.storeName !== "string") {
    throw new TypeError("A query plan requires a non-empty store name.");
  }
  if (!isValidNonNegativeInteger(source.offsetCount)) {
    throw new RangeError("Query offset must be a non-negative safe integer.");
  }
  if (!isValidNonNegativeInteger(source.limitCount)) {
    throw new RangeError("Query limit must be a non-negative safe integer.");
  }

  const ast: QueryAST<T> = {
    ...source,
    fieldPath: Array.isArray(source.fieldPath) ? [...source.fieldPath] : source.fieldPath,
    selectedFields: source.selectedFields ? [...source.selectedFields] : undefined,
  };
  const accessPath: QueryAccessPath = ast.primaryKeyLookup
    ? "primary-key"
    : ast.indexName
      ? "index"
      : "object-store";
  const requiresPostSort = ast.orderField !== undefined;
  const requiresPostFilter = ast.filterPredicate !== undefined;
  const summary: QueryPlanSummary = Object.freeze({
    storeName: ast.storeName,
    accessPath,
    indexName: ast.indexName,
    usesKeyRange: ast.range !== undefined,
    requiresPostFilter,
    requiresPostSort,
    sortField: ast.orderField,
    sortDirection: ast.orderDirection,
    pagination: requiresPostSort ? "materialize-and-slice" : "cursor",
    projectionFields: ast.selectedFields ? Object.freeze([...ast.selectedFields]) : undefined,
  });

  return Object.freeze({
    ast,
    summary,
    canUseNativeCount:
      Boolean(ast.isCount) && !requiresPostFilter && !requiresPostSort && !ast.selectedFields,
  });
}
