/**
 * Middleware plugin interface for intercepting read and write pipelines in the engine.
 */
export interface IDBMiddleware {
  /**
   * Unique identifier name for the middleware.
   */
  name: string;

  /**
   * Intercepts a record value immediately before it is written to storage.
   * Useful for field-level encryption, schema validation, data serialization, etc.
   *
   * @param ctx - Write context containing `storeName`, `operation`, and `value`.
   * @returns Transformed value to write to storage.
   */
  beforeWrite?: (ctx: {
    storeName: string;
    operation: "put" | "add";
    value: unknown;
  }) => Promise<unknown> | unknown;

  /**
   * Intercepts a record value immediately after it has been retrieved from storage.
   * Useful for field-level decryption, data deserialization, hydration, etc.
   *
   * @param ctx - Read context containing `storeName` and raw `value`.
   * @returns Transformed value returned to query caller.
   */
  afterRead?: (ctx: { storeName: string; value: unknown }) => Promise<unknown> | unknown;
}
