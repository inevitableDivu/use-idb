/**
 * Context provided to pre-write middleware hooks.
 */
export interface MiddlewareWriteContext {
  storeName: string;
  operation: "put" | "add";
  value: unknown;
  key?: IDBValidKey;
}

/**
 * Context provided to post-read middleware hooks.
 */
export interface MiddlewareReadContext {
  storeName: string;
  value: unknown;
  key?: IDBValidKey;
}

/**
 * Middleware plugin interface for intercepting read and write pipelines in the engine.
 */
export interface IDBMiddleware {
  /**
   * Unique identifier name for the middleware.
   */
  name: string;

  /**
   * Optional field paths transformed in persisted records. The engine uses this metadata to
   * reject encryption/serialization that would break primary-key or secondary-index lookups.
   * Adapters that cannot declare affected fields may omit it.
   */
  readonly transformedFieldPaths?: readonly string[];

  /**
   * Intercepts a record value immediately before it is written to storage.
   * Useful for field-level encryption, schema validation, data serialization, etc.
   *
   * @param ctx - Write context containing `storeName`, `operation`, `value`, and `key`.
   * @returns Transformed value to write to storage.
   */
  beforeWrite?: (ctx: MiddlewareWriteContext) => Promise<unknown> | unknown;

  /**
   * Intercepts a record value immediately after it has been retrieved from storage.
   * Useful for field-level decryption, data deserialization, hydration, etc.
   *
   * @param ctx - Read context containing `storeName`, raw `value`, and `key`.
   * @returns Transformed value returned to query caller.
   */
  afterRead?: (ctx: MiddlewareReadContext) => Promise<unknown> | unknown;
}
