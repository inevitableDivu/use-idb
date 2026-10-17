import { createDatabase, createEncryptionMiddleware, store } from "@inevitable_divu/use-idb";

interface PrivateNote {
  id: string;
  title: string;
  secret: string;
  updatedAt: Date;
}

export function createPrivateNotesDatabase(encryptionKey: CryptoKey) {
  return createDatabase(
    {
      name: "use-idb-example-private-notes",
      version: 1,
      stores: {
        notes: store<PrivateNote>()({ keyPath: "id" }),
      },
    },
    {
      middlewares: [createEncryptionMiddleware(encryptionKey, ["secret"])],
    },
  );
}

export async function savePrivateNote(
  encryptionKey: CryptoKey,
  note: PrivateNote,
): Promise<PrivateNote | undefined> {
  const db = createPrivateNotesDatabase(encryptionKey);
  await db.put("notes", note);
  return db.get("notes", note.id);
}

export async function createSessionEncryptionKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
