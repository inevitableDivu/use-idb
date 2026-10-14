import type { ILockPort } from "../../ports/lock.port";

/**
 * Null Object pattern implementation of {@link ILockPort}.
 *
 * Executes asynchronous callbacks immediately without cross-tab locking when `navigator.locks`
 * is unavailable or disabled.
 */
export class NoopLockAdapter implements ILockPort {
  async request<T>(_name: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}
