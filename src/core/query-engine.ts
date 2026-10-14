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

  where(indexName: string): this {
    this.ast.indexName = indexName;
    return this;
  }

  equals(key: IDBValidKey): this {
    this.ast.range = IDBKeyRange.only(key);
    return this;
  }

  between(lower: IDBValidKey, upper: IDBValidKey, lowerOpen = false, upperOpen = false): this {
    this.ast.range = IDBKeyRange.bound(lower, upper, lowerOpen, upperOpen);
    return this;
  }

  above(key: IDBValidKey, open = false): this {
    this.ast.range = IDBKeyRange.lowerBound(key, open);
    return this;
  }

  below(key: IDBValidKey, open = false): this {
    this.ast.range = IDBKeyRange.upperBound(key, open);
    return this;
  }

  direction(dir: CursorDirection): this {
    this.ast.direction = dir;
    return this;
  }

  filter(predicate: QueryFilterPredicate<T>): this {
    this.ast.filterPredicate = predicate;
    return this;
  }

  offset(count: number): this {
    this.ast.offsetCount = count;
    return this;
  }

  limit(count: number): this {
    this.ast.limitCount = count;
    return this;
  }

  getAST(): QueryAST<T> {
    return { ...this.ast };
  }

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

  async count(): Promise<number> {
    // If there's no filter, use native count for performance
    if (!this.ast.filterPredicate) {
      const range = this.ast.range instanceof IDBKeyRange ? this.ast.range : undefined;
      return this.storage.count(this.ast.storeName, range);
    }
    // With a filter, we need to iterate
    const results = await this.storage.cursor(this.ast);
    return results.length;
  }

  async first(): Promise<T | undefined> {
    this.ast.limitCount = 1;
    const results = await this.toArray();
    return results[0];
  }
}
