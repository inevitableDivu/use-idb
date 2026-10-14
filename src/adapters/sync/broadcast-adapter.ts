import type { ISyncPort, MutationEnvelope } from "../../ports/sync.port";

/**
 * Cross-tab synchronization adapter implementing {@link ISyncPort} via browser `BroadcastChannel`.
 *
 * Automatically filters out self-originated events by comparing incoming `originTabId` with local `tabId`.
 */
export class BroadcastSyncAdapter implements ISyncPort {
  readonly tabId: string;
  private channel: BroadcastChannel | null = null;
  private listeners = new Set<(envelope: MutationEnvelope) => void>();

  /**
   * Constructs the BroadcastSyncAdapter and binds to a named channel.
   *
   * @param dbName - Target database name.
   */
  constructor(dbName: string) {
    this.tabId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2);

    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(`use-idb:${dbName}`);
      this.channel.onmessage = (event: MessageEvent<MutationEnvelope>) => {
        const envelope = event.data;
        // Filter out self-originated events
        if (envelope.originTabId === this.tabId) return;
        for (const listener of this.listeners) {
          listener(envelope);
        }
      };
    }
  }

  /**
   * Broadcasts a mutation envelope to other tabs.
   *
   * @param envelope - Mutation metadata envelope.
   */
  publish(envelope: MutationEnvelope): void {
    this.channel?.postMessage(envelope);
  }

  /**
   * Subscribes to mutation events originating from other tabs.
   *
   * @param listener - Callback receiving remote mutation envelopes.
   * @returns Unsubscribe function.
   */
  subscribe(listener: (envelope: MutationEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Closes the active BroadcastChannel handle and clears listeners.
   */
  close(): void {
    this.channel?.close();
    this.channel = null;
    this.listeners.clear();
  }
}
