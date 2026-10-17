import type { ISyncPort, MutationEnvelope } from "../../ports/sync.port";

/**
 * Validates untrusted payload received over BroadcastChannel to prevent prototype
 * pollution or malformed messages from crashing DependencyTracker or causing invalidation storms.
 */
export function isMutationEnvelope(data: unknown): data is MutationEnvelope {
  if (data === null || typeof data !== "object") return false;
  const env = data as Partial<MutationEnvelope>;
  return (
    typeof env.originTabId === "string" &&
    typeof env.timestamp === "number" &&
    typeof env.storeName === "string" &&
    (env.operation === "put" ||
      env.operation === "delete" ||
      env.operation === "clear" ||
      env.operation === "bulk" ||
      env.operation === "force_release") &&
    Array.isArray(env.affectedKeys)
  );
}

/**
 * Cross-tab synchronization adapter implementing {@link ISyncPort} via browser `BroadcastChannel`.
 *
 * Automatically filters out self-originated events by comparing incoming `originTabId` with local `tabId`.
 * Protects against Node.js SSR MessagePort event-loop hangs and validates incoming payloads at runtime.
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

    // CRITICAL: Guard with `typeof window !== "undefined"` to prevent Node.js 18+
    // global BroadcastChannel from instantiating a MessagePort that prevents process exit.
    if (typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(`use-idb:${dbName}`);
      this.channel.onmessage = (event: MessageEvent<unknown>) => {
        if (!isMutationEnvelope(event.data)) {
          return;
        }
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
