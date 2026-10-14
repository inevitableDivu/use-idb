import type { ILockPort } from "../../ports/lock.port";

export class NoopLockAdapter implements ILockPort {
  async request<T>(_name: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}
