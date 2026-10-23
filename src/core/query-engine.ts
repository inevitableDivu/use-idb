import type {
  CursorDirection,
  QueryAST,
  QueryBuilder as QueryBuilderType,
  QueryFilterPredicate,
  ResolveWhereValue,
  SortDirection,
  ValidWhereField,
  WhereClause,
} from "../types/query";
import type { StoreConfig } from "../types/schema";
import { isValidKey, toKeyString } from "./key-serializer";
import type { IStoragePort } from "../ports/storage.port";
import { MiddlewarePipeline } from "../adapters/middleware/pipeline";
import { compileQueryPlan, type QueryPlanSummary } from "./query/query-plan";

/**
 * Fluent, type-safe query builder that compiles down to native
 * IDBIndex, IDBKeyRange, and IDBCursor operations.
 *
 * Supports fast-path optimization:
 * - If no JS filter, direction='next', offset=0 → native getAll() (5x faster)
 * - Otherwise → openCursor() with cursor.advance() for zero-allocation skipping
 */
export class QueryBuilder<T extends object, TStore = unknown, TResult = T>
  implements QueryBuilderType<T, TStore, TResult>
{
  private ast: QueryAST<T>;
  private storage: IStoragePort;
  private middleware: MiddlewarePipeline | null;
  private storeConfig?: StoreConfig<T>;
  private comparisonPredicates: QueryFilterPredicate<T>[] = [];
  private executionSignal?: AbortSignal;

  constructor(
    storage: IStoragePort,
    storeName: string,
    middleware?: MiddlewarePipeline,
    storeConfig?: StoreConfig<T>,
  ) {
    this.storage = storage;
    this.middleware = middleware ?? null;
    this.storeConfig = storeConfig;
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
  where<K extends ValidWhereField<T, TStore>>(
    field: K,
  ): WhereClause<T, TStore, ResolveWhereValue<T, TStore, K>, TResult> {
    this.setField(field);
    return this as unknown as WhereClause<T, TStore, ResolveWhereValue<T, TStore, K>, TResult>;
  }

  and<K extends ValidWhereField<T, TStore>>(
    field: K,
  ): WhereClause<T, TStore, ResolveWhereValue<T, TStore, K>, TResult> {
    this.setField(field);
    return this as unknown as WhereClause<T, TStore, ResolveWhereValue<T, TStore, K>, TResult>;
  }

  /** Attach a cancellation signal for this execution without changing the query description. */
  withSignal(signal: AbortSignal): this {
    this.executionSignal = signal;
    return this;
  }

  private throwIfAborted(): void {
    if (this.executionSignal?.aborted) {
      throw new DOMException("The query was aborted.", "AbortError");
    }
  }

  private setField(field: string): void {
    const indexes = this.storeConfig?.indexes ?? {};
    const directIndex = indexes[field];
    const propertyIndex = Object.entries(indexes).find(
      ([, index]) => this.pathsEqual(index.keyPath, field),
    );
    const matchingIndex = directIndex ? [field, directIndex] as const : propertyIndex;
    const fieldPath = matchingIndex?.[1].keyPath ?? field;
    const indexName = matchingIndex?.[0];
    const accessPathChanged =
      this.ast.fieldName !== field ||
      this.ast.indexName !== indexName ||
      JSON.stringify(this.ast.fieldPath) !== JSON.stringify(fieldPath);

    // A key range belongs to the index/primary-key path on which it was built.
    // Never carry it across field or index changes while composing a query.
    if (accessPathChanged) {
      this.ast.range = undefined;
      this.ast.primaryKeyLookup = false;
      this.ast.primaryKeyValue = undefined;
    }

    this.ast.fieldName = field;
    this.ast.fieldPath = fieldPath;
    this.ast.indexName = indexName;
    this.ast.indexMultiEntry = matchingIndex?.[1].multiEntry ?? false;
  }

  private pathsEqual(path: string | readonly string[], field: string): boolean {
    return typeof path === "string" ? path === field : path.length === 1 && path[0] === field;
  }

  private readField(record: T, path = this.ast.fieldPath): unknown {
    const readPath = (fieldPath: string): unknown => {
      let value: unknown = record;
      for (const part of fieldPath.split(".")) {
        if (value === null || typeof value !== "object") return undefined;
        value = (value as Record<string, unknown>)[part];
      }
      return value;
    };
    if (typeof path === "string") return readPath(path);
    if (path !== undefined) return [...path].map((fieldPath) => readPath(fieldPath));
    return readPath(this.ast.fieldName ?? "");
  }

  private compare(
    predicate: (field: unknown) => boolean,
    filterKey: string,
    requiresFilter: boolean,
  ): this {
    const previous = this.ast.filterPredicate;
    const path = this.ast.fieldPath;
    const fieldPredicate = (record: T) => {
      const value = this.readField(record, path);
      return this.ast.indexMultiEntry && Array.isArray(value)
        ? value.some(predicate)
        : predicate(value);
    };
    this.comparisonPredicates.push(fieldPredicate);
    if (requiresFilter || previous || this.comparisonPredicates.length > 1) {
      this.ast.filterPredicate = (record) =>
        this.comparisonPredicates.every((condition) => condition(record)) &&
        (previous ? previous(record) : true);
    }
    this.ast.filterKey = this.ast.filterKey
      ? `${this.ast.filterKey}&${filterKey}`
      : filterKey;
    return this;
  }

  equals(value: IDBValidKey): this {
    const isPrimaryKey = this.isPrimaryField();
    const optimized = Boolean(this.ast.indexName || isPrimaryKey) &&
      this.isIDBKey(value) &&
      this.ast.filterPredicate === undefined &&
      this.comparisonPredicates.length === 0;
    const isSinglePrimaryLookup = isPrimaryKey && optimized;
    const result = this.compare(
      (field) => this.valueEquals(field, value),
      `eq:${this.valueKey(value)}`,
      !optimized,
    );
    if (optimized) {
      this.ast.range = IDBKeyRange.only(value);
    } else {
      if (!this.ast.indexName && !isPrimaryKey) this.ast.range = undefined;
    }
    this.ast.primaryKeyLookup = isSinglePrimaryLookup && this.isIDBKey(value);
    this.ast.primaryKeyValue = this.ast.primaryKeyLookup ? value : undefined;
    return result;
  }

  private isIDBKey(value: unknown): value is IDBValidKey {
    return isValidKey(value);
  }

  private isPrimaryField(): boolean {
    return (
      this.storeConfig?.keyPath !== undefined &&
      this.pathsEqual(
        this.storeConfig.keyPath as string | readonly string[],
        this.ast.fieldName ?? "",
      )
    );
  }

  notEquals(value: IDBValidKey): this {
    return this.compare(
      (field) => !this.valueEquals(field, value),
      `ne:${this.valueKey(value)}`,
      true,
    );
  }

  anyOf(values: readonly IDBValidKey[]): this {
    return this.compare(
      (field) => values.some((value) => this.valueEquals(field, value)),
      `in:${values.map((value) => this.valueKey(value)).join(",")}`,
      true,
    );
  }

  gt(value: IDBValidKey): this {
    const optimized = Boolean(this.ast.indexName || this.isPrimaryField()) &&
      this.isIDBKey(value) &&
      this.ast.filterPredicate === undefined &&
      this.comparisonPredicates.length === 0;
    const result = this.compare(
      (field) => this.compareValues(field, value) > 0,
      `gt:${this.valueKey(value)}`,
      !optimized,
    );
    this.setRangeBound(value, "lower", true);
    return result;
  }

  gte(value: IDBValidKey): this {
    const optimized = Boolean(this.ast.indexName || this.isPrimaryField()) &&
      this.isIDBKey(value) &&
      this.ast.filterPredicate === undefined &&
      this.comparisonPredicates.length === 0;
    const result = this.compare(
      (field) => this.compareValues(field, value) >= 0,
      `gte:${this.valueKey(value)}`,
      !optimized,
    );
    this.setRangeBound(value, "lower", false);
    return result;
  }

  lt(value: IDBValidKey): this {
    const optimized = Boolean(this.ast.indexName || this.isPrimaryField()) &&
      this.isIDBKey(value) &&
      this.ast.filterPredicate === undefined &&
      this.comparisonPredicates.length === 0;
    const result = this.compare(
      (field) => this.compareValues(field, value) < 0,
      `lt:${this.valueKey(value)}`,
      !optimized,
    );
    this.setRangeBound(value, "upper", true);
    return result;
  }

  lte(value: IDBValidKey): this {
    const optimized = Boolean(this.ast.indexName || this.isPrimaryField()) &&
      this.isIDBKey(value) &&
      this.ast.filterPredicate === undefined &&
      this.comparisonPredicates.length === 0;
    const result = this.compare(
      (field) => this.compareValues(field, value) <= 0,
      `lte:${this.valueKey(value)}`,
      !optimized,
    );
    this.setRangeBound(value, "upper", false);
    return result;
  }

  between(lower: IDBValidKey, upper: IDBValidKey, includeLower = true, includeUpper = true): this {
    const optimized = Boolean(this.ast.indexName || this.isPrimaryField()) &&
      this.isIDBKey(lower) &&
      this.isIDBKey(upper) &&
      this.ast.filterPredicate === undefined &&
      this.comparisonPredicates.length === 0;
    const result = this.compare((field) => {
      const lowerComparison = this.compareValues(field, lower);
      const upperComparison = this.compareValues(field, upper);
      return (includeLower ? lowerComparison >= 0 : lowerComparison > 0) &&
        (includeUpper ? upperComparison <= 0 : upperComparison < 0);
    }, `between:${this.valueKey(lower)}:${this.valueKey(upper)}:${includeLower}:${includeUpper}`, !optimized);
    if (optimized) {
      this.ast.range = IDBKeyRange.bound(lower, upper, !includeLower, !includeUpper);
    } else {
      this.ast.range = undefined;
    }
    return result;
  }

  private setRangeBound(value: IDBValidKey, bound: "lower" | "upper", open: boolean): void {
    if (!(this.ast.indexName || this.isPrimaryField()) || !this.isIDBKey(value)) {
      this.ast.range = undefined;
      return;
    }
    this.ast.range = bound === "lower"
      ? IDBKeyRange.lowerBound(value, open)
      : IDBKeyRange.upperBound(value, open);
  }

  startsWith(prefix: string): this {
    return this.compare(
      (field) => typeof field === "string" && field.startsWith(prefix),
      `starts:${this.valueKey(prefix)}`,
      true,
    );
  }

  private valueKey(value: unknown): string {
    if (isValidKey(value) || typeof value === "boolean" || value === null) {
      return toKeyString(value);
    }
    return JSON.stringify(value) ?? Object.prototype.toString.call(value);
  }

  private valueEquals(left: unknown, right: unknown): boolean {
    if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
    if (Array.isArray(left) && Array.isArray(right)) {
      return left.length === right.length && left.every((value, index) => this.valueEquals(value, right[index]));
    }
    const leftBinary = left instanceof ArrayBuffer
      ? new Uint8Array(left)
      : ArrayBuffer.isView(left)
        ? new Uint8Array(left.buffer, left.byteOffset, left.byteLength)
        : null;
    const rightBinary = right instanceof ArrayBuffer
      ? new Uint8Array(right)
      : ArrayBuffer.isView(right)
        ? new Uint8Array(right.buffer, right.byteOffset, right.byteLength)
        : null;
    if (leftBinary || rightBinary) {
      return Boolean(
        leftBinary &&
        rightBinary &&
        leftBinary.byteLength === rightBinary.byteLength &&
        leftBinary.every((byte, index) => byte === rightBinary[index]),
      );
    }
    return Object.is(left, right);
  }

  private compareValues(left: unknown, right: unknown): number {
    if (Array.isArray(left) && Array.isArray(right)) {
      for (let index = 0; index < Math.min(left.length, right.length); index++) {
        const comparison = this.compareValues(left[index], right[index]);
        if (comparison !== 0) return comparison;
      }
      return left.length - right.length;
    }
    const normalizedLeft = left instanceof Date ? left.getTime() : left;
    const normalizedRight = right instanceof Date ? right.getTime() : right;
    if (normalizedLeft === normalizedRight) return 0;
    if (normalizedLeft === undefined || normalizedRight === undefined) return Number.NaN;
    return (normalizedLeft as string | number) < (normalizedRight as string | number) ? -1 : 1;
  }

  /**
   * Restricts results to keys strictly above the specified key (`IDBKeyRange.lowerBound`).
   *
   * @param key - Lower bound key.
   * @param open - Whether lower bound is exclusive (defaults to false).
   * @returns Current QueryBuilder for chaining.
   */
  above(key: IDBValidKey, open = false): this {
    return open ? this.gt(key) : this.gte(key);
  }

  /**
   * Restricts results to keys strictly below the specified key (`IDBKeyRange.upperBound`).
   *
   * @param key - Upper bound key.
   * @param open - Whether upper bound is exclusive (defaults to false).
   * @returns Current QueryBuilder for chaining.
   */
  below(key: IDBValidKey, open = false): this {
    return open ? this.lt(key) : this.lte(key);
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
    const previous = this.ast.filterPredicate;
    this.ast.filterPredicate = previous ? (record) => previous(record) && predicate(record) : predicate;
    this.ast.filterKey = this.ast.filterKey
      ? `${this.ast.filterKey}&filter:${predicate.toString()}`
      : `filter:${predicate.toString()}`;
    this.ast.primaryKeyLookup = false;
    return this;
  }

  orderBy<K extends Extract<keyof T, string>>(field: K, direction: SortDirection = "asc"): this {
    this.ast.orderField = field;
    this.ast.orderDirection = direction;
    return this;
  }

  select<K extends Extract<keyof T, string>>(
    ...fields: readonly K[]
  ): QueryBuilder<T, TStore, Pick<T, K>> {
    this.ast.selectedFields = fields;
    return this as unknown as QueryBuilder<T, TStore, Pick<T, K>>;
  }

  /**
   * Skips the specified number of records using zero-allocation `cursor.advance()`.
   *
   * @param count - Number of records to skip.
   * @returns Current QueryBuilder for chaining.
   */
  offset(count: number): this {
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError("Query offset must be a non-negative integer.");
    }
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
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError("Query limit must be a non-negative integer.");
    }
    this.ast.limitCount = count;
    return this;
  }

  /**
   * Returns a copy of the underlying query AST representation.
   */
  getAST(): QueryAST<T> {
    return compileQueryPlan(this.ast).ast;
  }

  /**
   * Explains which execution path the current query will use without reading storage.
   * This is intended for debugging unexpected scans, JavaScript filtering, and in-memory sorting.
   */
  explain(): QueryPlanSummary {
    return compileQueryPlan(this.ast).summary;
  }

  /**
   * Executes the compiled query and resolves all matched records into an array.
   * Automatically leverages the native fast-path `getAll()` when no in-memory filter or non-default direction is used.
   *
   * @returns Promise resolving to an array of matched records.
   */
  async toArray(): Promise<TResult[]> {
    this.throwIfAborted();
    const plan = compileQueryPlan(this.ast);
    const needsPostSort = plan.summary.requiresPostSort;
    const ast = needsPostSort
      ? { ...plan.ast, offsetCount: 0, limitCount: undefined }
      : plan.ast;
    let results: T[] = [];
    let resultKeys: (IDBValidKey | undefined)[] = [];
    if (
      ast.primaryKeyLookup &&
      ast.primaryKeyValue !== undefined &&
      ast.offsetCount === 0 &&
      (ast.limitCount === undefined || ast.limitCount > 0)
    ) {
      const result = await this.storage.get<T>(ast.storeName, ast.primaryKeyValue);
      this.throwIfAborted();
      if (result !== undefined) {
        results.push(result);
        resultKeys.push(ast.primaryKeyValue);
      }
    } else if (this.storage.cursorWithKeys) {
      const entries = await this.storage.cursorWithKeys<T>(ast, this.executionSignal);
      this.throwIfAborted();
      results = entries.map((entry) => entry.value);
      resultKeys = entries.map((entry) => entry.key);
    } else {
      results = await this.storage.cursor(ast, this.executionSignal);
      this.throwIfAborted();
      // Compatibility path for custom storage adapters that have not implemented
      // key-aware reads yet. Inline and compound key paths remain supported.
      const keyPath = this.storeConfig?.keyPath;
      resultKeys = results.map((item) => {
        if (keyPath === undefined || item === null || typeof item !== "object") return undefined;
        const paths: readonly string[] =
          typeof keyPath === "string" ? [keyPath] : (keyPath as readonly string[]);
        const parts = paths.map((path) => {
          let current: unknown = item;
          for (const part of path.split(".")) {
            if (current === null || typeof current !== "object") return undefined;
            current = (current as Record<string, unknown>)[part];
          }
          return current;
        });
        const candidate = Array.isArray(keyPath) ? parts : parts[0];
        return isValidKey(candidate) ? candidate : undefined;
      });
    }

    if (this.middleware) {
      const transformed: T[] = [];
      for (let index = 0; index < results.length; index++) {
        this.throwIfAborted();
        const processed = await this.middleware.runAfterRead(
          this.ast.storeName,
          results[index],
          resultKeys[index],
        );
        this.throwIfAborted();
        transformed.push(processed as T);
      }
      results = transformed;
    }

    if (this.ast.orderField) {
      const field = this.ast.orderField;
      const direction = this.ast.orderDirection === "desc" ? -1 : 1;
      results.sort((left, right) => {
        const a = (left as Record<string, unknown>)[field];
        const b = (right as Record<string, unknown>)[field];
        const leftValue = a instanceof Date ? a.getTime() : a;
        const rightValue = b instanceof Date ? b.getTime() : b;
        if (leftValue === rightValue) return 0;
        if (leftValue === undefined) return 1;
        if (rightValue === undefined) return -1;
        return ((leftValue as string | number) < (rightValue as string | number) ? -1 : 1) * direction;
      });
    }

    if (needsPostSort && this.ast.offsetCount > 0) {
      results = results.slice(this.ast.offsetCount);
    }
    if (needsPostSort && this.ast.limitCount !== undefined) {
      results = results.slice(0, this.ast.limitCount);
    }

    if (this.ast.selectedFields) {
      results = results.map((item) =>
        Object.fromEntries(
          this.ast.selectedFields!.map((field) => [field, (item as Record<string, unknown>)[field]]),
        ) as T,
      );
    }

    return results as unknown as TResult[];
  }

  /**
   * Configures the query builder to compile as a count query.
   */
  asCount(): QueryBuilder<T, TStore, number> {
    this.ast.isCount = true;
    return this as unknown as QueryBuilder<T, TStore, number>;
  }

  /**
   * Returns the count of matching records.
   * Uses native high-speed `IDBIndex.count()` when no in-memory filter is attached.
   *
   * @returns Total count of matching records.
   */
  async count(): Promise<number> {
    this.throwIfAborted();
    this.ast.isCount = true;
    const plan = compileQueryPlan(this.ast);
    if (this.executionSignal) {
      const rows = await this.storage.cursor(plan.ast, this.executionSignal);
      this.throwIfAborted();
      return rows.length;
    }
    if (plan.canUseNativeCount) {
      return this.storage.count(
        plan.ast.storeName,
        plan.ast.range,
        plan.ast.indexName,
        plan.ast.fieldPath,
        plan.ast.indexMultiEntry,
      );
    }
    // A post-filter or post-sort requires executing the full query semantics.
    const results = await this.storage.cursor(plan.ast);
    return results.length;
  }

  /**
   * Executes the query with `limit(1)` and returns the first matched record or `undefined`.
   *
   * @returns The first matching record, or `undefined` if none found.
   */
  async first(): Promise<TResult | undefined> {
    this.ast.limitCount = 1;
    const results = await this.toArray();
    return results[0];
  }
}
