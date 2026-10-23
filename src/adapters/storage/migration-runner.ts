import type { DatabaseSchema } from "../../types/schema";

/**
 * Runs schema migrations inside an `onupgradeneeded` transaction.
 * Diffs existing stores/indexes against the schema and creates/deletes as needed,
 * then executes incremental migration callbacks synchronously for versions in (oldVersion, newVersion].
 *
 * CRITICAL: IndexedDB `versionchange` transactions automatically commit as soon as control yields
 * to the browser event loop with no pending requests. Migrations MUST be completely synchronous IDB operations.
 */
export function runMigrations(
  db: IDBDatabase,
  tx: IDBTransaction,
  schema: DatabaseSchema,
  oldVersion: number,
  newVersion: number,
): void {
  if (!Number.isSafeInteger(schema.version) || schema.version < 1) {
    throw new TypeError("Database version must be a positive safe integer.");
  }
  if (!schema.name.trim()) {
    throw new TypeError("Database name must be a non-empty string.");
  }

  const existingStores = new Set(Array.from(db.objectStoreNames));
  const targetStores = new Set(Object.keys(schema.stores));
  const storesRequiringExplicitRebuild = new Set<string>();
  const hasMigrationForUpgrade = Array.from(
    { length: Math.max(0, newVersion - oldVersion) },
    (_, index) => oldVersion + index + 1,
  ).some((version) => typeof schema.migrations?.[version] === "function");

  for (const [storeName, config] of Object.entries(schema.stores)) {
    if (config.autoIncrement && Array.isArray(config.keyPath)) {
      throw new TypeError(
        `Store "${storeName}" cannot combine autoIncrement with a compound keyPath.`,
      );
    }
    for (const [indexName, index] of Object.entries(config.indexes ?? {})) {
      if (index.multiEntry && Array.isArray(index.keyPath)) {
        throw new TypeError(
          `Index "${storeName}.${indexName}" cannot combine multiEntry with a compound keyPath.`,
        );
      }
    }
  }

  // Delete removed stores
  for (const name of existingStores) {
    if (!targetStores.has(name)) {
      db.deleteObjectStore(name);
    }
  }

  // Create or update stores
  for (const [name, config] of Object.entries(schema.stores)) {
    let store: IDBObjectStore;

    if (!existingStores.has(name)) {
      store = db.createObjectStore(name, {
        keyPath: config.keyPath as string | string[] | null | undefined,
        autoIncrement: config.autoIncrement,
      });
    } else {
      store = tx.objectStore(name);
      const actualKeyPath = Array.isArray(store.keyPath)
        ? Array.from(store.keyPath)
        : store.keyPath;
      const configuredKeyPath =
        config.keyPath === undefined
          ? null
          : Array.isArray(config.keyPath)
            ? Array.from(config.keyPath)
            : config.keyPath;
      const expectedAutoIncrement = config.autoIncrement === true;
      if (
        JSON.stringify(actualKeyPath) !== JSON.stringify(configuredKeyPath) ||
        store.autoIncrement !== expectedAutoIncrement
      ) {
        if (!hasMigrationForUpgrade) {
          throw new Error(
            `Store "${name}" changed its primary key configuration. IndexedDB cannot alter keyPath or autoIncrement in place; add a synchronous migration for this version that rebuilds the store and copies its data.`,
          );
        }
        // A key-path change requires a developer-authored rebuild so data is not silently lost.
        // Let that migration replace the store and construct indexes with the intended schema.
        storesRequiringExplicitRebuild.add(name);
      }
    }

    if (storesRequiringExplicitRebuild.has(name)) continue;

    // Diff indexes
    const existingIndexes = new Set(Array.from(store.indexNames));
    const targetIndexes = config.indexes ? new Set(Object.keys(config.indexes)) : new Set<string>();

    // Delete removed indexes
    for (const idxName of existingIndexes) {
      if (!targetIndexes.has(idxName)) {
        store.deleteIndex(idxName);
      }
    }

    // Create new indexes and recreate indexes whose persisted definition changed.
    if (config.indexes) {
      for (const [idxName, idxConfig] of Object.entries(config.indexes)) {
        const exists = existingIndexes.has(idxName);
        let unchanged = false;

        if (exists) {
          const existingIndex = store.index(idxName);
          const existingPath = Array.isArray(existingIndex.keyPath)
            ? Array.from(existingIndex.keyPath)
            : existingIndex.keyPath;
          const targetPath = Array.isArray(idxConfig.keyPath)
            ? Array.from(idxConfig.keyPath)
            : idxConfig.keyPath;
          unchanged =
            JSON.stringify(existingPath) === JSON.stringify(targetPath) &&
            existingIndex.unique === (idxConfig.unique ?? false) &&
            existingIndex.multiEntry === (idxConfig.multiEntry ?? false);
        }

        if (!unchanged) {
          if (exists) store.deleteIndex(idxName);
          store.createIndex(idxName, idxConfig.keyPath as string | string[], {
            unique: idxConfig.unique ?? false,
            multiEntry: idxConfig.multiEntry ?? false,
          });
        }
      }
    }
  }

  // Run incremental migration callbacks synchronously
  if (schema.migrations) {
    for (let v = oldVersion + 1; v <= newVersion; v++) {
      const migrateFn = schema.migrations[v];
      if (migrateFn) {
        const result = migrateFn({ db, transaction: tx, oldVersion, newVersion }) as unknown;
        if (result && typeof (result as Promise<unknown>).then === "function") {
          console.error(
            `[use-idb Critical Error] Migration v${v} returned a Promise. IndexedDB versionchange transactions auto-commit when microtask control yields to the event loop. Migrations must be synchronous IDB operations.`,
          );
          throw new Error(
            `Migration for version ${v} returned a Promise. IndexedDB versionchange transactions must be strictly synchronous.`,
          );
        }
      }
    }
  }
}
