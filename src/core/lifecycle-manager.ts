import type { DatabaseSchema } from "../types/schema";
import type { IStoragePort } from "../ports/storage.port";
import type { ResolvedEngineConfig } from "./config";
import { createMemoryFallbackStorage } from "./adapter-factory";

/** Callback contract keeps Engine as the composition root while this service owns lifecycle policy. */
export interface StorageLifecycleCallbacks {
  getStorage(): IStoragePort;
  replaceStorage(storage: IStoragePort, reason: string): Promise<void>;
  onPersistentStorageResult(granted: boolean | null): void;
  onOpened(): void;
}

/**
 * Owns open/fallback/persistent-storage policy independently from CRUD and React concerns.
 *
 * It falls back only for recognized environment-availability failures. Schema migration,
 * version, quota, and transaction failures remain visible to the caller.
 */
export class StorageLifecycleManager {
  private persistentRequest?: Promise<boolean>;

  constructor(
    private readonly schema: DatabaseSchema<any>,
    private readonly config: ResolvedEngineConfig,
    private readonly callbacks: StorageLifecycleCallbacks,
  ) {}

  async open(): Promise<void> {
    const storage = this.callbacks.getStorage();
    try {
      await storage.open();
      if (storage.kind === "indexeddb" && this.config.fallback.requestPersistentStorage) {
        const granted = await this.requestPersistentStorage(storage);
        this.callbacks.onPersistentStorageResult(granted);
      }
      this.callbacks.onOpened();
    } catch (error) {
      if (
        this.config.fallback.strategy !== "memory" ||
        storage.kind !== "indexeddb" ||
        !this.isFallbackEligibleError(error)
      ) {
        throw error;
      }

      const reason = error instanceof Error ? error.message : String(error);
      const fallbackStorage = createMemoryFallbackStorage(this.schema);
      await fallbackStorage.open();
      await this.callbacks.replaceStorage(fallbackStorage, reason);
      this.callbacks.onPersistentStorageResult(false);
      this.callbacks.onOpened();
    }
  }

  async close(): Promise<void> {
    await this.callbacks.getStorage().close();
  }

  private async requestPersistentStorage(storage: IStoragePort): Promise<boolean> {
    if (this.persistentRequest) return this.persistentRequest;
    this.persistentRequest =
      storage.requestPersistentStorage?.().catch(() => false) ?? Promise.resolve(false);
    return this.persistentRequest;
  }

  private isFallbackEligibleError(error: unknown): boolean {
    const name =
      typeof error === "object" && error !== null && "name" in error
        ? String((error as { name?: unknown }).name)
        : "";
    return name === "SecurityError" || name === "NotSupportedError";
  }
}
