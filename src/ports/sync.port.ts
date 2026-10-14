export interface MutationEnvelope {
  originTabId: string;
  timestamp: number;
  storeName: string;
  operation: "put" | "delete" | "clear" | "bulk";
  affectedKeys: IDBValidKey[];
}

export interface ISyncPort {
  readonly tabId: string;
  publish(envelope: MutationEnvelope): void;
  subscribe(listener: (envelope: MutationEnvelope) => void): () => void;
  close(): void;
}
