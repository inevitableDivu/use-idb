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
  const existingStores = new Set(Array.from(db.objectStoreNames));
  const targetStores = new Set(Object.keys(schema.stores));

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
        keyPath: config.keyPath,
        autoIncrement: config.autoIncrement,
      });
    } else {
      store = tx.objectStore(name);
    }

    // Diff indexes
    const existingIndexes = new Set(Array.from(store.indexNames));
    const targetIndexes = config.indexes ? new Set(Object.keys(config.indexes)) : new Set<string>();

    // Delete removed indexes
    for (const idxName of existingIndexes) {
      if (!targetIndexes.has(idxName)) {
        store.deleteIndex(idxName);
      }
    }

    // Create missing indexes
    if (config.indexes) {
      for (const [idxName, idxConfig] of Object.entries(config.indexes)) {
        if (!existingIndexes.has(idxName)) {
          store.createIndex(idxName, idxConfig.keyPath as string | string[], {
            unique: idxConfig.unique,
            multiEntry: idxConfig.multiEntry,
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
