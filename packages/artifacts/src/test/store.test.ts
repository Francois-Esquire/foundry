import { describe, expect, test } from "vitest";

import { blobIdSchema } from "../ref";
import { InMemoryArtifactStore } from "../store/memory";
import { SqliteArtifactStore } from "../store/sqlite";
import { describeArtifactManager } from "../testing/manager";
import { describeArtifactStore } from "../testing/store";
import { recordingStores } from "./helpers/recording";
import { libsqlDatabases } from "./helpers/sqlite";

function memoryStorage() {
  const scopes = new Map<string, InMemoryArtifactStore>();
  return (scope: string) => {
    const store = scopes.get(scope) ?? new InMemoryArtifactStore();
    scopes.set(scope, store);
    return store;
  };
}

describeArtifactStore("In-memory", memoryStorage, { hooked: false });
describeArtifactManager("In-memory", () => new InMemoryArtifactStore());

for (const location of ["memory", "file"] as const) {
  const databases = libsqlDatabases(location);
  async function sqliteStorage() {
    const database = await databases.open();
    const scopes = new Map<string, SqliteArtifactStore>();
    return (scope: string) => {
      const store =
        scopes.get(scope) ?? new SqliteArtifactStore({ database, scope });
      scopes.set(scope, store);
      return store;
    };
  }
  describeArtifactStore(`SQLite on libSQL (${location})`, sqliteStorage, {
    hooked: true,
    recording: async () => recordingStores(await databases.open()),
  });
  describeArtifactManager(
    `SQLite on libSQL (${location})`,
    async () =>
      new SqliteArtifactStore({ database: await databases.open(), scope: "s" })
  );
}

describe("InMemoryArtifactStore's starting records", () => {
  test("are its own, even where the caller's bytes sit over shared memory", async () => {
    const bytes = new Uint8Array(new SharedArrayBuffer(1));
    bytes[0] = 1;
    const id = blobIdSchema.parse("shared");
    const store = new InMemoryArtifactStore({
      records: {
        artifacts: [],
        blobs: [
          {
            byteLength: 1,
            bytes,
            createdAt: new Date(0),
            digest: "a".repeat(64),
            id,
          },
        ],
        contents: [],
      },
    });
    bytes[0] = 9;

    const stored = await store.getBlob(id);
    expect(stored?.bytes).toEqual(new Uint8Array([1]));
    expect(stored?.bytes?.buffer).not.toBeInstanceOf(SharedArrayBuffer);
  });
});
