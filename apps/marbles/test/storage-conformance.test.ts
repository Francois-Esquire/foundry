import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "~/database/migrate";
import { applyMigrations, schemaState } from "~/database/migrate-core";
import { BUNDLED_MIGRATIONS } from "~/database/migrations/bundled";
import { marblesChanges } from "~/database/tables";
import { asRun } from "~/lib/calling-run";
import { causingRun } from "~/lib/events/records";
import { PORTABLE_OWNER_LIVENESS } from "~/lib/owner-liveness";
import { MemoryMarblesStorage } from "~/storage/memory";
import { SqliteMarblesStorage } from "~/storage/sqlite";
import { defineStorageConformanceTests } from "./helpers/storage-conformance";

const NODE_BUILTIN =
  /^(?:node:|bun:|(?:assert|async_hooks|buffer|child_process|cluster|crypto|dgram|dns|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|timers|tls|tty|url|util|v8|vm|worker_threads|zlib)(?:\/|$))/;

defineStorageConformanceTests("MemoryMarblesStorage", async () => ({
  storage: new MemoryMarblesStorage(),
}));

defineStorageConformanceTests("SqliteMarblesStorage", async () => {
  const client = createClient({ url: ":memory:" });
  const database = drizzle({ client });
  await applyMigrations(database, {
    file: ":memory:",
    foreignKeys: async (enabled) => {
      await client.execute(`PRAGMA foreign_keys = ${enabled ? "ON" : "OFF"}`);
    },
  });
  const storage = new SqliteMarblesStorage({
    close: () => {
      client.close();
    },
    database,
    liveness: PORTABLE_OWNER_LIVENESS,
  });
  return {
    storage,
  };
});

describe("static bundled SQLite migrations", () => {
  it("applies bundled migrations to a fresh in-memory SQLite DB without reading disk and is idempotent", async () => {
    const client = createClient({ url: ":memory:" });
    try {
      const database = drizzle({ client });
      expect(
        await schemaState(database, BUNDLED_MIGRATIONS, ":memory:")
      ).toEqual({ kind: "empty" });

      await applyMigrations(database);
      expect(
        await schemaState(database, BUNDLED_MIGRATIONS, ":memory:")
      ).toEqual({ kind: "current" });

      await applyMigrations(database);
      const [row] = await database.values<[number]>(
        sql`SELECT count(*) FROM __drizzle_migrations`
      );
      expect(Number(row?.[0])).toBe(BUNDLED_MIGRATIONS.length);
    } finally {
      client.close();
    }
  });

  it("matches generated disk migrations exactly", () => {
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")
    ) as { readonly entries: readonly { readonly tag: string }[] };
    const fromDisk = readMigrationFiles({ migrationsFolder: MIGRATIONS }).map(
      (migration, index) => ({
        hash: migration.hash,
        sql: migration.sql,
        tag: journal.entries[index]?.tag ?? String(index),
        when: migration.folderMillis,
      })
    );
    expect(BUNDLED_MIGRATIONS).toEqual(fromDisk);
  });

  it("storage/ports, storage/memory, and database/migrate-core bundle with zero Node built-ins", async () => {
    const workspaceRoot = resolve(import.meta.dirname, "../../..");
    const virtualEntry = resolve(
      import.meta.dirname,
      "__storage-portable-smoke__.ts"
    );
    const portsPath = resolve(import.meta.dirname, "../src/storage/ports.ts");
    const memoryPath = resolve(import.meta.dirname, "../src/storage/memory.ts");
    const migrateCorePath = resolve(
      import.meta.dirname,
      "../src/database/migrate-core.ts"
    );
    const forbiddenImports: string[] = [];

    const built = await globalThis.Bun.build({
      entrypoints: [virtualEntry],
      files: {
        [virtualEntry]: [
          `export { resourceRefKey } from ${JSON.stringify(portsPath)};`,
          `export { MemoryMarblesStorage, MemoryRunStreamStorage } from ${JSON.stringify(memoryPath)};`,
          `export { applyMigrations, schemaState } from ${JSON.stringify(migrateCorePath)};`,
        ].join("\n"),
      },
      format: "esm",
      minify: false,
      plugins: [
        {
          name: "forbid-node-builtins",
          setup(build) {
            build.onResolve({ filter: NODE_BUILTIN }, (args) => {
              forbiddenImports.push(`${args.importer} -> ${args.path}`);
              return { external: true, path: args.path };
            });
          },
        },
      ],
      root: workspaceRoot,
      target: "browser",
    });

    expect(forbiddenImports).toEqual([]);
    expect(built.success).toBe(true);
  });
});

it("attributes SQLite adapter run events through the injected resolver after await", async () => {
  const client = createClient({ url: ":memory:" });
  const database = drizzle({ client });
  const storage = new SqliteMarblesStorage({
    causingRun: () => causingRun() ?? undefined,
    database,
  });
  try {
    await applyMigrations(database);
    const stores = await storage.forWorkspace("workspace");
    const commit = (id: string) =>
      Effect.runPromise(
        stores.queue.commit({
          events: [
            {
              at: 0,
              id,
              run: {
                attempt: 1,
                id: "rn-child",
                jobId: "jb-child",
                pool: "default",
                revision: 0,
                state: { availableAt: 0, kind: "queued", queuedAt: 0 },
              },
              type: "run.queued",
            },
          ],
        })
      );
    await asRun("rn-parent", async () => {
      await Promise.resolve();
      await commit("inside");
    });
    await commit("outside");
    const rows = await database
      .select({ id: marblesChanges.id, runId: marblesChanges.runId })
      .from(marblesChanges);
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: "inside", runId: "rn-parent" },
        { id: "outside", runId: null },
      ])
    );
    expect(rows).toHaveLength(2);
  } finally {
    await storage.close();
    client.close();
  }
});
