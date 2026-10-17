import { createDatabase, store } from "@inevitable_divu/use-idb";

interface Bookmark {
  id: string;
  url: string;
  label: string;
  createdAt: Date;
}

const db = createDatabase({
  name: "use-idb-example-bookmarks",
  version: 1,
  stores: {
    bookmarks: store<Bookmark>()({
      keyPath: "id",
      indexes: { by_created: "createdAt" },
    }),
  },
});

export interface BookmarkBackup {
  version: 1;
  bookmarks: Array<Omit<Bookmark, "createdAt"> & { createdAt: string }>;
}

export async function exportBookmarks(): Promise<string> {
  const backup: BookmarkBackup = {
    version: 1,
    bookmarks: (await db.getAll("bookmarks")).map((bookmark) => ({
      id: bookmark.id,
      url: bookmark.url,
      label: bookmark.label,
      createdAt: bookmark.createdAt.toISOString(),
    })),
  };
  return JSON.stringify(backup, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBookmark(value: unknown): Bookmark {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.url !== "string" ||
    typeof value.label !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    throw new TypeError("Bookmark backup contains an invalid record.");
  }

  const createdAt = new Date(value.createdAt);
  if (Number.isNaN(createdAt.getTime())) {
    throw new TypeError(`Bookmark "${value.id}" has an invalid creation date.`);
  }

  return {
    id: value.id,
    url: value.url,
    label: value.label,
    createdAt,
  };
}

export async function importBookmarks(serializedBackup: string): Promise<number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serializedBackup);
  } catch (error) {
    throw new TypeError("Bookmark backup must contain valid JSON.", { cause: error });
  }

  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.bookmarks)) {
    throw new TypeError("Unsupported or malformed bookmark backup.");
  }

  const bookmarks = parsed.bookmarks.map(parseBookmark);
  await db.putMany("bookmarks", bookmarks);
  return bookmarks.length;
}
