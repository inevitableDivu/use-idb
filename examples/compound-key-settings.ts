import { createDatabase, store } from "@inevitable_divu/use-idb";

interface UserSettings {
  workspaceId: string;
  userId: string;
  theme: "light" | "dark";
  compactMode: boolean;
}

const db = createDatabase({
  name: "use-idb-example-settings",
  version: 1,
  stores: {
    settings: store<UserSettings>()({
      keyPath: ["workspaceId", "userId"],
      indexes: { by_workspace: "workspaceId" },
    }),
  },
});

export async function saveUserSettings(settings: UserSettings) {
  const key = await db.put("settings", settings);
  const saved = await db.get("settings", key);
  if (!saved) {
    throw new Error("Settings could not be read after saving.");
  }
  return saved;
}

export async function listWorkspaceSettings(workspaceId: string): Promise<UserSettings[]> {
  return db.query("settings").where("by_workspace").equals(workspaceId).toArray();
}
