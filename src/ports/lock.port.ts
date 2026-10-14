/**
 * Concurrency Lock Port interface defining mutual exclusion across browser contexts.
 */
export interface ILockPort {
  /**
   * Acquires a named lock, executes the asynchronous callback, and releases the lock upon completion.
   *
   * @template T - Return type of callback.
   * @param name - Resource lock name.
   * @param fn - Asynchronous work executed while holding the lock.
   */
  request<T>(name: string, fn: () => Promise<T>): Promise<T>;
}
