import type { ConnectionState, StorageQuota } from "../types/status";
import type { QueryAST } from "../types/query";

export interface StorageBatchOp {
  type: "put" | "delete";
  key?: IDBValidKey;
  value?: unknown;
}

export interface IStorageTransaction {
  get<T>(storeName: string, key: IDBValidKey): Promise<T | undefined>;
  put(storeName: string, value: unknown, key?: IDBValidKey): Promise<IDBValidKey>;
  delete(storeName: string, key: IDBValidKey): Promise<void>;
  clear(storeName: string): Promise<void>;
}

export interface IStoragePort {
  open(): Promise<void>;
  close(): Promise<void>;
  getState(): ConnectionState;
  onStateChange(listener: (state: ConnectionState) => void): () => void;
  get<T>(storeName: string, key: IDBValidKey): Promise<T | undefined>;
  getAll<T>(
    storeName: string,
    indexName?: string,
    range?: IDBKeyRange | IDBValidKey,
    limit?: number,
  ): Promise<T[]>;
  put(storeName: string, value: unknown, key?: IDBValidKey): Promise<IDBValidKey>;
  delete(storeName: string, key: IDBValidKey): Promise<void>;
  clear(storeName: string): Promise<void>;
  count(storeName: string, range?: IDBKeyRange | IDBValidKey): Promise<number>;
  batch(storeName: string, ops: StorageBatchOp[]): Promise<(IDBValidKey | undefined)[]>;
  transaction<T>(
    storeNames: string[],
    mode: "readonly" | "readwrite",
    fn: (tx: IStorageTransaction) => Promise<T>,
  ): Promise<T>;
  cursor<T>(ast: QueryAST<T>): Promise<T[]>;
  getQuota(): Promise<StorageQuota>;
  isUpgradeBlocked(): boolean;
  requiresReloadForUpgrade(): boolean;
}
