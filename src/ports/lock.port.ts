export interface ILockPort {
  request<T>(name: string, fn: () => Promise<T>): Promise<T>;
}
