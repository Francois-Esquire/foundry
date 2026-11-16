import type { SessionStore } from "../../store";
import { InMemorySessionStore } from "../../store/memory";
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
    ["InMemorySessionStore", () => Promise.resolve(new InMemorySessionStore())],
    sqlite("memory"),
    sqlite("file"),
  ];
}
