import type { ILockPort } from "../../ports/lock.port";

/**
 * Web Locks API adapter for exclusive concurrency control.
 * Falls back to direct execution if navigator.locks is unavailable.
 */
export class WebLocksAdapter implements ILockPort {
  async request<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (typeof navigator !== "undefined" && navigator.locks) {
      return navigator.locks.request(name, () => fn());
    }
    return fn();
  }
}
