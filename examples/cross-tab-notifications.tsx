import { createDatabase, createDatabaseHooks, store } from "@inevitable_divu/use-idb";

interface Announcement {
  id: string;
  message: string;
  createdAt: Date;
}

const db = createDatabase({
  name: "use-idb-example-announcements",
  version: 1,
  stores: {
    announcements: store<Announcement>()({
      keyPath: "id",
      indexes: { by_created: "createdAt" },
    }),
  },
});

const { useLiveQuery, useMutation } = createDatabaseHooks(db);

export function CrossTabAnnouncements() {
  const { data: announcements = [], error } = useLiveQuery(
    (database) => database.query("announcements").orderBy("createdAt", "desc").limit(10).toArray(),
    [],
  );
  const { put, isPending } = useMutation("announcements");

  async function announce() {
    await put({
      id: crypto.randomUUID(),
      message: "A change from this tab is shared with other open tabs.",
      createdAt: new Date(),
    });
  }

  return (
    <section>
      <button disabled={isPending} onClick={() => void announce()}>
        Post announcement
      </button>
      {error && <p role="alert">{error.message}</p>}
      <ul>
        {announcements.map((announcement) => (
          <li key={announcement.id}>{announcement.message}</li>
        ))}
      </ul>
    </section>
  );
}
