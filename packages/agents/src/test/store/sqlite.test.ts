import { SessionWindow } from "../../contexts/session-window";
import type { SessionStore } from "../../store";
import type { SessionDatabase } from "../../store/sqlite";
import { SqliteSessionStore } from "../../store/sqlite";
import { describeSessionStore } from "../../testing/store";
import { libsqlDatabases } from "../helpers/sqlite";

/**
 * One store per scope over one database, as a host keeps it: each store's
 * turns cover only itself, and two over one database would not wait for
 * each other (the README's host requirement). Asking for a scope again
 * returns that same store, as the memory store's storage does.
 */
function scopedStores(
  database: SessionDatabase,
  wrap: (store: SessionStore) => SessionStore = (store) => store
): (scope: string) => SessionStore {
  const scopes = new Map<string, SessionStore>();
  return (scope) => {
    const store =
      scopes.get(scope) ?? wrap(new SqliteSessionStore({ database, scope }));
    scopes.set(scope, store);
    return store;
  };
}

for (const location of ["memory", "file"] as const) {
  const databases = libsqlDatabases(location);
  describeSessionStore(`SqliteSessionStore on libSQL (${location})`, async () =>
    scopedStores(await databases.open())
  );
  // A window forwards the store it wraps, refusals from inside a
  // transaction included.
  describeSessionStore(
    `SessionWindow over SqliteSessionStore on libSQL (${location})`,
    async () =>
      scopedStores(await databases.open(), (store) => new SessionWindow(store))
  );
}
