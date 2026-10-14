import type { DatabaseSchema } from "../../types/schema";

/**
 * Runs schema migrations inside an `onupgradeneeded` transaction.
 * Diffs existing stores/indexes against the schema and creates/deletes as needed,
 * then executes incremental migration callbacks for versions in (oldVersion, newVersion].
 */
export async function runMigrations(
  db: IDBDatabase,
  tx: IDBTransaction,
  schema: DatabaseSchema,
  oldVersion: number,
  newVersion: number,
): Promise<void> {
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

  // Run incremental migration callbacks
  if (schema.migrations) {
    for (let v = oldVersion + 1; v <= newVersion; v++) {
      const migrateFn = schema.migrations[v];
      if (migrateFn) {
        await migrateFn({ db, transaction: tx, oldVersion, newVersion });
      }
    }
  }
}
