import type { ConnectionState, StorageQuota } from "../types/status";
import type { QueryAST } from "../types/query";

/**
 * A stored value paired with its actual IndexedDB primary key.
 * Key-aware reads are required by middleware that authenticates data against its storage key.
 */
export interface StorageEntry<T> {
  key: IDBValidKey;
  value: T;
}

/**
 * Individual atomic operation within a storage batch.
 */
export interface StorageBatchOp {
  /**
   * Type of write operation.
   */
  type: "put" | "delete";

  /**
   * Primary key for the record (required for delete, optional for put with keyPath).
   */
  key?: IDBValidKey;

  /**
   * Value to store (for put operations).
   */
  value?: unknown;
}

/**
 * Transaction execution scope provided to explicit `transaction()` callbacks.
 */
export interface IStorageTransaction {
  /**
   * Reads a record by primary key within the active transaction scope.
   */
  get<T>(storeName: string, key: IDBValidKey): Promise<T | undefined>;

  /**
   * Writes a record within the active transaction scope.
   */
  put(storeName: string, value: unknown, key?: IDBValidKey): Promise<IDBValidKey>;

  /**
   * Deletes a record within the active transaction scope.
   */
  delete(storeName: string, key: IDBValidKey): Promise<void>;

  /**
   * Clears all records in the specified store within the active transaction scope.
   */
  clear(storeName: string): Promise<void>;
}

/**
 * Storage Port interface defining the contract between the hexagonal core engine
 * and low-level persistence mechanisms (IndexedDB, In-Memory, etc.).
 */
export interface IStoragePort {
  /**
   * Opens and initializes the underlying storage engine, running any necessary schema migrations.
   */
  open(): Promise<void>;

  /**
   * Closes active database handles and terminates open transactions.
   */
  close(): Promise<void>;

  /**
   * Returns the current connection state.
   */
  getState(): ConnectionState;

  /**
   * Subscribes to connection state transitions.
   */
  onStateChange(listener: (state: ConnectionState) => void): () => void;

  /**
   * Retrieves a single record by primary key.
   */
  get<T>(storeName: string, key: IDBValidKey): Promise<T | undefined>;

  /**
   * Retrieves all records from a store or index, optionally constrained by range and limit.
   */
  getAll<T>(
    storeName: string,
    indexName?: string,
    range?: IDBKeyRange | IDBValidKey,
    limit?: number,
  ): Promise<T[]>;

  /**
   * Retrieves records together with their actual primary keys when supported by the adapter.
   * Optional to preserve compatibility with custom storage adapters.
   */
  getAllWithKeys?<T>(
    storeName: string,
    indexName?: string,
    range?: IDBKeyRange | IDBValidKey,
    limit?: number,
  ): Promise<StorageEntry<T>[]>;

  /**
   * Writes a record directly to storage.
   */
  put(storeName: string, value: unknown, key?: IDBValidKey): Promise<IDBValidKey>;

  /**
   * Deletes a record by primary key directly from storage.
   */
  delete(storeName: string, key: IDBValidKey): Promise<void>;

  /**
   * Clears all records from the target object store.
   */
  clear(storeName: string): Promise<void>;

  /**
   * Returns the count of records matching an optional key range.
   */
  count(
    storeName: string,
    range?: IDBKeyRange | IDBValidKey,
    indexName?: string,
    keyPath?: string | readonly string[],
    multiEntry?: boolean,
  ): Promise<number>;

  /**
   * Executes a synchronous batch of put/delete operations inside a single atomic transaction.
   */
  batch(storeName: string, ops: StorageBatchOp[]): Promise<(IDBValidKey | undefined)[]>;

  /**
   * Executes an explicit transaction across one or more object stores.
   */
  transaction<T>(
    storeNames: string[],
    mode: "readonly" | "readwrite",
    fn: (tx: IStorageTransaction) => Promise<T>,
  ): Promise<T>;

  /**
   * Compiles and executes an abstract syntax tree query via native getAll or IDBCursor.
   */
  cursor<T>(ast: QueryAST<T>): Promise<T[]>;

  /**
   * Executes a query and returns each result with its actual primary key when supported.
   */
  cursorWithKeys?<T>(ast: QueryAST<T>): Promise<StorageEntry<T>[]>;

  /**
   * Queries storage quota and usage from the browser.
   */
  getQuota(): Promise<StorageQuota>;

  /**
   * Returns whether a database version upgrade is currently blocked by another open tab.
   */
  isUpgradeBlocked(): boolean;

  /**
   * Returns whether this tab closed its connection due to another tab performing an upgrade.
   */
  requiresReloadForUpgrade(): boolean;
}
