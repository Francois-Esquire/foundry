import type { SessionStore } from "../../store";
import { MemorySessionStore } from "../../store/memory";
import { SqliteSessionStore } from "../../store/sqlite";
import { libsqlDatabases } from "./sqlite";

export type SessionStoreKind = readonly [
  name: string,
  open: () => Promise<SessionStore>,
];

export function sessionStoreKinds(): readonly SessionStoreKind[] {
  const sqlite = (location: "file" | "memory"): SessionStoreKind => {
    const databases = libsqlDatabases(location);
    return [
      `SqliteSessionStore on libSQL (${location})`,
      async () =>
        new SqliteSessionStore({
          database: await databases.open(),
          scope: "s",
        }),
    ];
  };
  return [
    ["MemorySessionStore", () => Promise.resolve(new MemorySessionStore())],
    sqlite("memory"),
    sqlite("file"),
  ];
}
