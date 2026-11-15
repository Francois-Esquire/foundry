import { describe, expect, it } from "vitest";
import { SessionWindow } from "../../contexts/session-window";
import type { SessionStore } from "../../store";
import type { SessionDatabase } from "../../store/sqlite";
import { capturedSessionWrite, SqliteSessionStore } from "../../store/sqlite";
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

describe("capturedSessionWrite", () => {
  class Point {
    readonly x = 1;
  }
  const message = (input: unknown) => ({
    createdAt: 1,
    id: "m",
    parts: [
      { input, name: "tool", toolCallId: "c", type: "tool_call" as const },
    ],
    role: "assistant" as const,
    sessionId: "s",
    status: "complete" as const,
    updatedAt: 1,
  });

  it("refuses what commit refuses, with the same error", async () => {
    const database = await libsqlDatabases("memory").open();
    const write = { putMessages: [message(new Point())] };
    const refused = await new SqliteSessionStore({ database, scope: "s" })
      .commit(write)
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect(refused).toBeInstanceOf(RangeError);
    expect(() => capturedSessionWrite(write)).toThrow(
      (refused as Error).message
    );
  });

  it("keeps only the write's own fields, and shares nothing with it", () => {
    const input = { n: 1 };
    const write = { extra: () => undefined, putMessages: [message(input)] };
    const copy = capturedSessionWrite(write);
    input.n = 2;
    write.putMessages.length = 0;
    expect(copy).toEqual({ putMessages: [message({ n: 1 })] });
  });
});
