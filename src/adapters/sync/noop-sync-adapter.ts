import type { ISyncPort, MutationEnvelope } from "../../ports/sync.port";

/**
 * Null Object pattern implementation of {@link ISyncPort}.
 *
 * Used when running in Server-Side Rendering (SSR / Node.js) environments where `BroadcastChannel`
 * is not available, when `enableCrossTabSync: false` is configured, or in isolated single-client testing.
 */
export class NoopSyncAdapter implements ISyncPort {
  readonly tabId: string;

  constructor() {
    this.tabId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2);
  }

  /**
   * No-op publish method.
   */
  publish(_envelope: MutationEnvelope): void {
    // No-op in SSR / fallback environments
  }

  /**
   * No-op subscribe method returning an empty unsubscription callback.
   */
  subscribe(_listener: (envelope: MutationEnvelope) => void): () => void {
    return () => {};
  }

  /**
   * No-op teardown method.
   */
  close(): void {
    // No-op
  }
}
