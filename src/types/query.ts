export type CursorDirection = "next" | "nextunique" | "prev" | "prevunique";

export type QueryFilterPredicate<T> = (record: T) => boolean;

export interface QueryAST<T = unknown> {
  storeName: string;
  indexName?: string;
  range?: IDBKeyRange | IDBValidKey;
  direction: CursorDirection;
  filterPredicate?: QueryFilterPredicate<T>;
  offsetCount: number;
  limitCount?: number;
}

export interface LiveQueryOptions<T = unknown> {
  initialData?: T;
  suspense?: boolean;
  enabled?: boolean;
}
