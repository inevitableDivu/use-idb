/**
 * Mutation envelope broadcast across tabs to notify listeners of committed database changes.
 */
export interface MutationEnvelope {
  /**
   * Unique tab/client identifier originating the mutation.
   */
  originTabId: string;

  /**
   * Unix epoch timestamp in milliseconds when the mutation was committed.
   */
  timestamp: number;

  /**
   * Name of the object store modified.
   */
  storeName: string;

  /**
   * Type of mutation applied.
   */
  operation: "put" | "delete" | "clear" | "bulk";

  /**
   * Array of primary keys affected by the mutation (empty for "clear").
   */
  affectedKeys: IDBValidKey[];
}

/**
 * Sync Port interface defining cross-tab mutation event distribution.
 */
export interface ISyncPort {
  /**
   * Unique client ID for this tab instance.
   */
  readonly tabId: string;

  /**
   * Publishes a mutation envelope to all other listening tabs.
   */
  publish(envelope: MutationEnvelope): void;

  /**
   * Subscribes to mutation envelopes originating from other tabs.
   */
  subscribe(listener: (envelope: MutationEnvelope) => void): () => void;

  /**
   * Closes underlying communication channels.
   */
  close(): void;
}
