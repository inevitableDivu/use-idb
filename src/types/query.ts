/**
 * Direction for IDBCursor traversal.
 */
import type {
  IndexInput,
  InferIndexValue,
  StringKeyOf,
} from "./schema";

export type SortDirection = "asc" | "desc";

export type CursorDirection = "next" | "nextunique" | "prev" | "prevunique";

/**
 * In-memory JavaScript filter predicate applied to records matched by cursor or index.
 */
export type QueryFilterPredicate<T> = (record: T) => boolean;

/** Context supplied to live query callbacks for cooperative cancellation of custom async work. */
export interface QueryExecutionContext {
  readonly signal: AbortSignal;
}

export type ResolveWhereValue<TItem extends object, TStore, K extends string> = K extends keyof TItem
  ? TItem[K]
  : TStore extends { readonly $types: { readonly indexes: infer TIndexes } }
    ? K extends keyof TIndexes
      ? TIndexes[K] extends IndexInput<TItem>
        ? InferIndexValue<TItem, TIndexes[K]>
        : never
      : never
    : never;

export type ValidWhereField<TItem extends object, TStore> =
  | StringKeyOf<TItem>
  | (TStore extends { readonly $types: { readonly indexes: infer TIndexes } }
      ? Extract<keyof TIndexes, string>
      : never);

export interface WhereClause<TItem extends object, TStore, TValue, TResult = TItem> {
  equals(value: TValue): QueryBuilder<TItem, TStore, TResult>;
  notEquals(value: TValue): QueryBuilder<TItem, TStore, TResult>;
  anyOf(values: readonly TValue[]): QueryBuilder<TItem, TStore, TResult>;
  gt(value: TValue): QueryBuilder<TItem, TStore, TResult>;
  gte(value: TValue): QueryBuilder<TItem, TStore, TResult>;
  lt(value: TValue): QueryBuilder<TItem, TStore, TResult>;
  lte(value: TValue): QueryBuilder<TItem, TStore, TResult>;
  between(lower: TValue, upper: TValue, includeLower?: boolean, includeUpper?: boolean): QueryBuilder<TItem, TStore, TResult>;
  above(value: TValue, open?: boolean): QueryBuilder<TItem, TStore, TResult>;
  below(value: TValue, open?: boolean): QueryBuilder<TItem, TStore, TResult>;
  startsWith(prefix: TValue extends string ? string : never): QueryBuilder<TItem, TStore, TResult>;
  direction(direction: CursorDirection): QueryBuilder<TItem, TStore, TResult>;
  filter(predicate: QueryFilterPredicate<TItem>): QueryBuilder<TItem, TStore, TResult>;
  orderBy<K extends StringKeyOf<TItem>>(field: K, direction?: SortDirection): QueryBuilder<TItem, TStore, TResult>;
  limit(count: number): QueryBuilder<TItem, TStore, TResult>;
  offset(count: number): QueryBuilder<TItem, TStore, TResult>;
  select<K extends StringKeyOf<TItem>>(...fields: readonly K[]): QueryBuilder<TItem, TStore, Pick<TItem, K>>;
  toArray(): Promise<TResult[]>;
  first(): Promise<TResult | undefined>;
  count(): Promise<number>;
  /** Inspect the selected access path and any required JavaScript post-processing. */
  explain(): {
    readonly storeName: string;
    readonly accessPath: "primary-key" | "index" | "object-store";
    readonly indexName?: string;
    readonly usesKeyRange: boolean;
    readonly requiresPostFilter: boolean;
    readonly requiresPostSort: boolean;
    readonly sortField?: string;
    readonly sortDirection?: SortDirection;
    readonly pagination: "cursor" | "materialize-and-slice";
    readonly projectionFields?: readonly string[];
  };
}

export interface QueryBuilder<TItem extends object, TStore = unknown, TResult = TItem> {
  where<K extends ValidWhereField<TItem, TStore>>(
    field: K,
  ): WhereClause<TItem, TStore, ResolveWhereValue<TItem, TStore, K>, TResult>;
  and<K extends ValidWhereField<TItem, TStore>>(
    field: K,
  ): WhereClause<TItem, TStore, ResolveWhereValue<TItem, TStore, K>, TResult>;
  filter(predicate: QueryFilterPredicate<TItem>): QueryBuilder<TItem, TStore, TResult>;
  direction(direction: CursorDirection): QueryBuilder<TItem, TStore, TResult>;
  orderBy<K extends StringKeyOf<TItem>>(
    field: K,
    direction?: SortDirection,
  ): QueryBuilder<TItem, TStore, TResult>;
  limit(count: number): QueryBuilder<TItem, TStore, TResult>;
  offset(count: number): QueryBuilder<TItem, TStore, TResult>;
  select<K extends StringKeyOf<TItem>>(...fields: readonly K[]): QueryBuilder<TItem, TStore, Pick<TItem, K>>;
  toArray(): Promise<TResult[]>;
  first(): Promise<TResult | undefined>;
  count(): Promise<number>;
  /** Inspect the selected access path and any required JavaScript post-processing. */
  explain(): {
    readonly storeName: string;
    readonly accessPath: "primary-key" | "index" | "object-store";
    readonly indexName?: string;
    readonly usesKeyRange: boolean;
    readonly requiresPostFilter: boolean;
    readonly requiresPostSort: boolean;
    readonly sortField?: string;
    readonly sortDirection?: SortDirection;
    readonly pagination: "cursor" | "materialize-and-slice";
    readonly projectionFields?: readonly string[];
  };
}

/**
 * Abstract Syntax Tree representation of a compiled IndexedDB query.
 *
 * @template T - The entity record type.
 */
export interface QueryAST<T = unknown> {
  /**
   * Target object store name.
   */
  storeName: string;

  /**
   * Target index name on the object store, if any.
   */
  indexName?: string;
  indexMultiEntry?: boolean;

  /** Queried model field and its physical key path, when known. */
  fieldName?: string;
  fieldPath?: string | readonly string[];
  primaryKeyValue?: IDBValidKey;
  primaryKeyLookup?: boolean;

  /** Post-index predicate for a field comparison. */
  fieldPredicate?: QueryFilterPredicate<T>;
  filterKey?: string;

  /** Sort model field, used when an IndexedDB index is not suitable. */
  orderField?: string;
  orderDirection?: SortDirection;
  selectedFields?: readonly string[];

  /**
   * Key range or exact key restriction (`IDBKeyRange` or valid key).
   */
  range?: IDBKeyRange | IDBValidKey;

  /**
   * Traversal direction of cursor.
   */
  direction: CursorDirection;

  /**
   * Optional in-memory filter predicate.
   */
  filterPredicate?: QueryFilterPredicate<T>;

  /**
   * Number of items to skip.
   */
  offsetCount: number;

  /**
   * Maximum number of items to return.
   */
  limitCount?: number;

  /**
   * Whether this is a `.count()` query.
   */
  isCount?: boolean;

  /**
   * Optional developer-supplied query key for deterministic cache indexing.
   */
  queryKey?: string;
}

/**
 * Options for the `useLiveQuery` hook.
 *
 * @template T - Result type.
 */
export interface LiveQueryOptions<T = unknown> {
  /**
   * Initial synchronous fallback data while query is resolving.
   */
  initialData?: T;

  /**
   * If `true`, integrates with React `<Suspense>` by throwing the active promise while fetching.
   *
   * @default false
   */
  suspense?: boolean;

  /**
   * Whether the query subscription is actively enabled. If `false`, query does not run.
   *
   * @default true
   */
  enabled?: boolean;

  /**
   * Explicit cache query key to disambiguate dynamic filter predicates or queries.
   */
  queryKey?: string;

  /**
   * Object stores read by an async/custom query that does not return QueryBuilder metadata.
   * Supplying this skips dependency-discovery invocation of the callback, avoiding duplicate
   * fetches or other work before the real execution. Such queries are invalidated at store level.
   */
  stores?: readonly string[];
}
