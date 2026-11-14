import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTables } from "@foundry/lib/testing/sqlite";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { onTestFinished } from "vitest";

import { JsonArtifactStore } from "../../node/json-store";
import type { ArtifactStore } from "../../store";
import { InMemoryArtifactStore } from "../../store/memory";
import { SqliteArtifactStore } from "../../store/sqlite";
import { ARTIFACT_TABLES } from "./sqlite";

/** Every kind of Artifact store the package's tests run over. */
export const STORE_KINDS = ["memory", "json", "sqlite"] as const;
export type StoreKind = (typeof STORE_KINDS)[number];

/**
 * A fresh, empty store of `kind`: the memory store, a JSON records file in
 * a temporary directory, or the SQLite store on a libSQL `:memory:`
 * database. Call it from inside a test; the file or database goes when the
 * test ends.
 */
export async function openStore(kind: StoreKind): Promise<ArtifactStore> {
  switch (kind) {
    case "memory":
      return new InMemoryArtifactStore();
    case "json": {
      const root = await mkdtemp(join(tmpdir(), "artifact-store-"));
      onTestFinished(() => rm(root, { force: true, recursive: true }));
      return new JsonArtifactStore({ path: join(root, "records.json") });
    }
    default: {
      const client = createClient({ url: ":memory:" });
      onTestFinished(() => client.close());
      const database = drizzle(client);
      await createTables(database, ARTIFACT_TABLES);
      return new SqliteArtifactStore({ database, scope: "test" });
    }
  }
}
