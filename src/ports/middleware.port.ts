export interface IDBMiddleware {
  name: string;
  beforeWrite?: (ctx: {
    storeName: string;
    operation: "put" | "add";
    value: unknown;
  }) => Promise<unknown> | unknown;

  afterRead?: (ctx: { storeName: string; value: unknown }) => Promise<unknown> | unknown;
}
