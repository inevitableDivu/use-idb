import type { ISyncPort, MutationEnvelope } from "../../ports/sync.port";

/**
 * Validate untrusted BroadcastChannel data before it reaches cache invalidation logic.
 * Unversioned envelopes are accepted for compatibility with tabs running the previous release.
 */
function isSafeIDBKey(value: unknown, depth = 0, ancestors = new WeakSet<object>()): value is IDBValidKey {
  if (depth > 32 || value === null || value === undefined) return false;
  if (typeof value === "string") return true;
  if (typeof value === "number") return !Number.isNaN(value);
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
  if (Array.isArray(value)) {
    if (value.length > 256 || ancestors.has(value)) return false;
    ancestors.add(value);
    const valid = value.every((part) => isSafeIDBKey(part, depth + 1, ancestors));
    ancestors.delete(value);
    return valid;
  }
  return false;
}

export function isMutationEnvelope(data: unknown): data is MutationEnvelope {
  if (data === null || typeof data !== "object") return false;
  const env = data as Partial<MutationEnvelope>;
  if (env.version !== undefined && env.version !== 1) return false;
  if (typeof env.originTabId !== "string" || env.originTabId.length === 0 || env.originTabId.length > 128) {
    return false;
  }
  if (typeof env.timestamp !== "number" || !Number.isFinite(env.timestamp)) return false;
  if (typeof env.storeName !== "string" || env.storeName.length === 0 || env.storeName.length > 256) {
    return false;
  }
  if (
    env.operation !== "put" &&
    env.operation !== "delete" &&
    env.operation !== "clear" &&
    env.operation !== "bulk" &&
    env.operation !== "invalidate" &&
    env.operation !== "force_release"
  ) {
    return false;
  }
  if (env.operation === "force_release" && env.storeName !== "*") return false;
  return (
    Array.isArray(env.affectedKeys) &&
    env.affectedKeys.length <= 10_000 &&
    env.affectedKeys.every((key) => isSafeIDBKey(key))
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
        // Normalize unversioned legacy messages before they reach code that treats the
        // envelope as the current public type.
        const envelope: MutationEnvelope = event.data.version === undefined
          ? { ...event.data, version: 1 }
          : event.data;
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
    try {
      this.channel?.postMessage(envelope);
    } catch {
      // Notifications are best-effort. A channel failure cannot roll back a committed database write.
    }
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
