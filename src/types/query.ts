/**
 * Direction for IDBCursor traversal.
 */
export type CursorDirection = "next" | "nextunique" | "prev" | "prevunique";

/**
 * In-memory JavaScript filter predicate applied to records matched by cursor or index.
 */
export type QueryFilterPredicate<T> = (record: T) => boolean;

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
}
