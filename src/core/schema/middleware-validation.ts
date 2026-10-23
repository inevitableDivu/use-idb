import type { DatabaseSchema, StoreConfig } from "../../types/schema";
import type { IDBMiddleware } from "../../ports/middleware.port";
import { MiddlewareSchemaConflictError } from "../errors";

function pathsOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}.`) ||
    right.startsWith(`${left}.`)
  );
}

function keyPaths(path: string | readonly string[] | undefined): string[] {
  if (path === undefined) return [];
  return typeof path === "string" ? [path] : [...path];
}

/**
 * Validate middleware's declared field transformations against durable key/index paths.
 * Encryption envelopes cannot be used as normal IDB primary keys or index keys, so fail during
 * database construction rather than after the first write silently breaks queries.
 */
export function validateMiddlewareSchema(
  schema: DatabaseSchema<any>,
  middlewares: readonly IDBMiddleware[],
): void {
  const declarations = middlewares.flatMap((middleware) =>
    (middleware.transformedFieldPaths ?? []).map((path) => ({ middleware, path })),
  );
  if (declarations.length === 0) return;

  for (const [storeName, config] of Object.entries(
    schema.stores as Record<string, StoreConfig<unknown, IDBValidKey>>,
  )) {
    const protectedPaths = [
      ...keyPaths(config.keyPath),
      ...Object.values(config.indexes ?? {}).flatMap((index) => keyPaths(index.keyPath)),
    ];

    for (const declaration of declarations) {
      for (const protectedPath of protectedPaths) {
        if (pathsOverlap(declaration.path, protectedPath)) {
          throw new MiddlewareSchemaConflictError(
            declaration.middleware.name,
            storeName,
            declaration.path,
            protectedPath,
          );
        }
      }
    }
  }
}
