import { createDatabase, store } from "@inevitable_divu/use-idb";

interface OutboxEntry {
  id: string;
  resource: string;
  payload: Record<string, unknown>;
  queuedAt: Date;
  attempts: number;
}

const db = createDatabase({
  name: "use-idb-example-outbox",
  version: 1,
  stores: {
    outbox: store<OutboxEntry>()({
      keyPath: "id",
      indexes: { by_queued_at: "queuedAt" },
    }),
  },
});

export async function queueForSync(
  resource: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const entry: OutboxEntry = {
    id: crypto.randomUUID(),
    resource,
    payload,
    queuedAt: new Date(),
    attempts: 0,
  };
  return db.put("outbox", entry);
}

export async function syncOutbox(send: (entry: OutboxEntry) => Promise<void>): Promise<number> {
  const pending = await db.query("outbox").orderBy("queuedAt", "asc").toArray();
  let synced = 0;

  for (const entry of pending) {
    try {
      await send(entry);
      await db.delete("outbox", entry.id);
      synced++;
    } catch (error) {
      await db.put("outbox", { ...entry, attempts: entry.attempts + 1 });
      throw error;
    }
  }

  return synced;
}

export async function pendingSyncCount(): Promise<number> {
  return db.query("outbox").count();
}
