import type { ILockPort } from "../../ports/lock.port";

/**
 * Web Locks API adapter implementing {@link ILockPort} for exclusive cross-tab concurrency control.
 *
 * Utilizes `navigator.locks.request` to prevent race conditions during version upgrades
 * or competing transactions. Automatically falls back to direct execution if `navigator.locks` is unsupported.
 */
export class WebLocksAdapter implements ILockPort {
  /**
   * Acquires a web lock with the given name and runs the asynchronous task.
   *
   * @template T - Return type.
   * @param name - Named lock resource identifier.
   * @param fn - Asynchronous callback to execute while holding lock.
   */
  async request<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (typeof navigator !== "undefined" && navigator.locks) {
      return navigator.locks.request(name, () => fn());
    }
    return fn();
  }
}
