import type { ISyncPort, MutationEnvelope } from "../../ports/sync.port";

/**
 * Cross-tab synchronization adapter using BroadcastChannel.
 * Filters out self-originated events via tabId comparison.
 */
export class BroadcastSyncAdapter implements ISyncPort {
  readonly tabId: string;
  private channel: BroadcastChannel | null = null;
  private listeners = new Set<(envelope: MutationEnvelope) => void>();

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

  publish(envelope: MutationEnvelope): void {
    this.channel?.postMessage(envelope);
  }

  subscribe(listener: (envelope: MutationEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    this.channel?.close();
    this.channel = null;
    this.listeners.clear();
  }
}
