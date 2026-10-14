import type { ISyncPort, MutationEnvelope } from "../../ports/sync.port";

export class NoopSyncAdapter implements ISyncPort {
  readonly tabId: string;

  constructor() {
    this.tabId = Math.random().toString(36).slice(2);
  }

  publish(_envelope: MutationEnvelope): void {
    // No-op in SSR / fallback environments
  }

  subscribe(_listener: (envelope: MutationEnvelope) => void): () => void {
    return () => {};
  }

  close(): void {
    // No-op
  }
}
