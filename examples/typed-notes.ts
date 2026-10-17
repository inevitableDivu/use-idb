import { createDatabase, store } from "@inevitable_divu/use-idb";

interface Note {
  id: string;
  notebookId: string;
  title: string;
  body: string;
  updatedAt: Date;
}

const db = createDatabase({
  name: "use-idb-example-notes",
  version: 1,
  stores: {
    notes: store<Note>()({
      keyPath: "id",
      indexes: {
        by_notebook: "notebookId",
        by_updated: "updatedAt",
      },
    }),
  },
});

export async function runTypedNotesExample() {
  const note: Note = {
    id: crypto.randomUUID(),
    notebookId: "work",
    title: "Release checklist",
    body: "Verify the offline workflow before shipping.",
    updatedAt: new Date(),
  };

  await db.put("notes", note);

  const savedNote = await db.get("notes", note.id);
  if (!savedNote) {
    throw new Error("The note was not saved.");
  }

  await db.put("notes", {
    ...savedNote,
    body: "Verify the offline workflow and migration before shipping.",
    updatedAt: new Date(),
  });

  const recentlyUpdated = await db
    .query("notes")
    .where("by_updated")
    .above(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
    .toArray();

  await db.delete("notes", note.id);
  return recentlyUpdated;
}
