export interface UseIdbOptions<T> {
  defaultValue?: T;
  dbName?: string;
  storeName?: string;
  version?: number;
}

export interface UseIdbReturn<T> {
  value: T | undefined;
  setValue: (val: T | ((prev: T | undefined) => T)) => Promise<void>;
  loading: boolean;
  error: Error | null;
}
