/**
 * Errors exposed by the database orchestration layer.
 *
 * Keeping these contracts outside Engine avoids making callers import the implementation
 * module just to discriminate known configuration or middleware failures.
 */
export class TransactionMiddlewareUnsupportedError extends Error {
  constructor() {
    super(
      "Explicit transactions cannot run with middleware enabled because asynchronous transformations can outlive an IndexedDB transaction. Use the standard Engine CRUD/batch APIs, or run the transaction without middleware.",
    );
    this.name = "TransactionMiddlewareUnsupportedError";
  }
}

export class DatabaseConfigurationConflictError extends Error {
  constructor(databaseName: string, conflicts: string[]) {
    super(
      `Database "${databaseName}" is already registered with a different configuration (${conflicts.join(", ")}). Reuse the original Engine or destroy it before registering a different configuration.`,
    );
    this.name = "DatabaseConfigurationConflictError";
  }
}

/**
 * Thrown when a requested schema transition cannot be applied without a developer-authored
 * data migration.
 */
export class DatabaseSchemaTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseSchemaTransitionError";
  }
}

/**
 * Thrown when an operation is attempted after an Engine has been destroyed.
 */
export class DatabaseDestroyedError extends Error {
  constructor(databaseName: string) {
    super(`Database "${databaseName}" has been destroyed. Create a new Engine instance before using it again.`);
    this.name = "DatabaseDestroyedError";
  }
}


/**
 * Thrown when middleware transforms a primary-key or indexed path and would make normal
 * IndexedDB key/index lookups invalid or ambiguous.
 */
export class MiddlewareSchemaConflictError extends Error {
  constructor(middlewareName: string, storeName: string, transformedPath: string, protectedPath: string) {
    super(
      `Middleware "${middlewareName}" transforms "${storeName}.${transformedPath}", which overlaps primary-key/index path "${storeName}.${protectedPath}". Do not encrypt or transform key/index paths; store searchable metadata separately.`,
    );
    this.name = "MiddlewareSchemaConflictError";
  }
}
