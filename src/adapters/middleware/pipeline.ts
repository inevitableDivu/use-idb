import type { IDBMiddleware } from "../../ports/middleware.port";

/**
 * Sequentially runs middleware hooks for pre-write and post-read transformations.
 *
 * CRITICAL: Must NEVER be called while an IDBTransaction is active.
 * The caller (WriteCoalescer / QueryEngine) is responsible for ensuring
 * middleware runs BEFORE opening or AFTER closing IDB transactions.
 */
export class MiddlewarePipeline {
  private readonly middlewares: IDBMiddleware[];

  constructor(middlewares: IDBMiddleware[]) {
    this.middlewares = middlewares;
  }

  async runBeforeWrite(
    storeName: string,
    operation: "put" | "add",
    value: unknown,
    key?: IDBValidKey,
  ): Promise<unknown> {
    let current = value;
    for (const mw of this.middlewares) {
      if (mw.beforeWrite) {
        current = await mw.beforeWrite({ storeName, operation, value: current, key });
      }
    }
    return current;
  }

  async runAfterRead(storeName: string, value: unknown, key?: IDBValidKey): Promise<unknown> {
    let current = value;
    for (const mw of this.middlewares) {
      if (mw.afterRead) {
        current = await mw.afterRead({ storeName, value: current, key });
      }
    }
    return current;
  }
}
