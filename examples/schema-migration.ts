import { createDatabase, store } from "@inevitable_divu/use-idb";

interface Profile {
  id: string;
  fullName: string;
  displayName?: string;
}

const db = createDatabase({
  name: "use-idb-example-profiles",
  version: 2,
  stores: {
    profiles: store<Profile>()({
      keyPath: "id",
      indexes: {
        by_display_name: "displayName",
      },
    }),
  },
  migrations: {
    2: ({ transaction }) => {
      const profiles = transaction.objectStore("profiles");
      const cursorRequest = profiles.openCursor();

      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;

        const profile = cursor.value as Profile;
        if (profile.displayName === undefined) {
          cursor.update({ ...profile, displayName: profile.fullName });
        }
        cursor.continue();
      };
    },
  },
});

export async function runProfileMigrationExample() {
  await db.open();
  return db.query("profiles").orderBy("displayName").toArray();
}
