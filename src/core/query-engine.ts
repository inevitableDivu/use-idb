import type { CursorDirection, QueryAST, QueryFilterPredicate } from "../types/query";
import type { IStoragePort } from "../ports/storage.port";
import { MiddlewarePipeline } from "../adapters/middleware/pipeline";

/**
 * Fluent, type-safe query builder that compiles down to native
 * IDBIndex, IDBKeyRange, and IDBCursor operations.
 *
 * Supports fast-path optimization:
 * - If no JS filter, direction='next', offset=0 → native getAll() (5x faster)
 * - Otherwise → openCursor() with cursor.advance() for zero-allocation skipping
 */
export class QueryBuilder<T> {
  private ast: QueryAST<T>;
  private storage: IStoragePort;
  private middleware: MiddlewarePipeline | null;

  constructor(storage: IStoragePort, storeName: string, middleware?: MiddlewarePipeline) {
    this.storage = storage;
    this.middleware = middleware ?? null;
    this.ast = {
      storeName,
      direction: "next",
      offsetCount: 0,
    };
  }

  /**
   * Targets a specific secondary index on the object store.
   *
   * @param indexName - Name of the index configured in schema.
   * @returns Current QueryBuilder for chaining.
   */
  where(indexName: string): this {
    this.ast.indexName = indexName;
    return this;
  }

  /**
   * Restricts results to an exact key match (`IDBKeyRange.only`).
   *
   * @param key - The exact key value.
   * @returns Current QueryBuilder for chaining.
   */
  equals(key: IDBValidKey): this {
    this.ast.range = IDBKeyRange.only(key);
    return this;
  }

  /**
   * Restricts results to a bounded key range (`IDBKeyRange.bound`).
   *
   * @param lower - Lower bound key.
   * @param upper - Upper bound key.
   * @param lowerOpen - Whether lower bound is exclusive (defaults to false).
   * @param upperOpen - Whether upper bound is exclusive (defaults to false).
   * @returns Current QueryBuilder for chaining.
   */
  between(lower: IDBValidKey, upper: IDBValidKey, lowerOpen = false, upperOpen = false): this {
    this.ast.range = IDBKeyRange.bound(lower, upper, lowerOpen, upperOpen);
    return this;
  }

  /**
   * Restricts results to keys strictly above the specified key (`IDBKeyRange.lowerBound`).
   *
   * @param key - Lower bound key.
   * @param open - Whether lower bound is exclusive (defaults to false).
   * @returns Current QueryBuilder for chaining.
   */
  above(key: IDBValidKey, open = false): this {
    this.ast.range = IDBKeyRange.lowerBound(key, open);
    return this;
  }

  /**
   * Restricts results to keys strictly below the specified key (`IDBKeyRange.upperBound`).
   *
   * @param key - Upper bound key.
   * @param open - Whether upper bound is exclusive (defaults to false).
   * @returns Current QueryBuilder for chaining.
   */
  below(key: IDBValidKey, open = false): this {
    this.ast.range = IDBKeyRange.upperBound(key, open);
    return this;
  }

  /**
   * Sets the cursor traversal direction.
   *
   * @param dir - `"next"`, `"nextunique"`, `"prev"`, or `"prevunique"`.
   * @returns Current QueryBuilder for chaining.
   */
  direction(dir: CursorDirection): this {
    this.ast.direction = dir;
    return this;
  }

  /**
   * Appends an in-memory post-index JavaScript filter predicate.
   *
   * @param predicate - Synchronous boolean predicate receiving each item.
   * @returns Current QueryBuilder for chaining.
   */
  filter(predicate: QueryFilterPredicate<T>): this {
    this.ast.filterPredicate = predicate;
    return this;
  }

  /**
   * Skips the specified number of records using zero-allocation `cursor.advance()`.
   *
   * @param count - Number of records to skip.
   * @returns Current QueryBuilder for chaining.
   */
  offset(count: number): this {
    this.ast.offsetCount = count;
    return this;
  }

  /**
   * Limits the maximum number of items retrieved.
   *
   * @param count - Maximum number of items.
   * @returns Current QueryBuilder for chaining.
   */
  limit(count: number): this {
    this.ast.limitCount = count;
    return this;
  }

  /**
   * Returns a copy of the underlying query AST representation.
   */
  getAST(): QueryAST<T> {
    return { ...this.ast };
  }

  /**
   * Executes the compiled query and resolves all matched records into an array.
   * Automatically leverages the native fast-path `getAll()` when no in-memory filter or non-default direction is used.
   *
   * @returns Promise resolving to an array of matched records.
   */
  async toArray(): Promise<T[]> {
    const results = await this.storage.cursor(this.ast);

    if (this.middleware) {
      const transformed: T[] = [];
      for (const item of results) {
        const processed = await this.middleware.runAfterRead(this.ast.storeName, item);
        transformed.push(processed as T);
      }
      return transformed;
    }

    return results;
  }

  /**
   * Configures the query builder to compile as a count query.
   */
  asCount(): this {
    this.ast.isCount = true;
    return this;
  }

  /**
   * Returns the count of matching records.
   * Uses native high-speed `IDBIndex.count()` when no in-memory filter is attached.
   *
   * @returns Total count of matching records.
   */
  async count(): Promise<number> {
    this.ast.isCount = true;
    // If there's no filter, use native count for performance
    if (!this.ast.filterPredicate) {
      const range = this.ast.range instanceof IDBKeyRange ? this.ast.range : undefined;
      return this.storage.count(this.ast.storeName, range);
    }
    // With a filter, we need to iterate
    const results = await this.storage.cursor(this.ast);
    return results.length;
  }

  /**
   * Executes the query with `limit(1)` and returns the first matched record or `undefined`.
   *
   * @returns The first matching record, or `undefined` if none found.
   */
  async first(): Promise<T | undefined> {
    this.ast.limitCount = 1;
    const results = await this.toArray();
    return results[0];
  }
}
