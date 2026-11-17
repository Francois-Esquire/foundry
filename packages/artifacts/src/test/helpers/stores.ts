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

export const STORE_KINDS = ["memory", "json", "sqlite"] as const;
export type StoreKind = (typeof STORE_KINDS)[number];

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
