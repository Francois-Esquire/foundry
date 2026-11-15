import type { SessionStore } from "../../store";
import { InMemorySessionStore } from "../../store/memory";
import { SqliteSessionStore } from "../../store/sqlite";
import { libsqlDatabases } from "./sqlite";

/** A store kind by name, and how to open a fresh, empty one. */
export type SessionStoreKind = readonly [
  name: string,
  open: () => Promise<SessionStore>,
];

/**
 * Every store `Sessions` and its wrappers run over in tests: memory, and
 * SQLite on libSQL in memory and on a file. Call it at the top level of a
 * test file: the SQLite kinds close their databases after each test.
 */
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
