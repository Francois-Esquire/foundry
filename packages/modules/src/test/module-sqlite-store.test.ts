import type { ArtifactId, ContentId } from "@foundry/artifacts";
import { eq, getTableColumns, sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, test } from "vitest";
import type { z } from "zod";

import type { InstallationId, ModuleId } from "../domain";
import type { ModuleManifest } from "../manifest";
import { ModuleRegistry } from "../registry";
import type {
  Installation,
  InstallationGrant,
  Module,
  StoredInstallation,
  StoredManifest,
} from "../schema";
import {
  installationSchema,
  moduleSchema,
  storedInstallationSchema,
  storedManifestSchema,
} from "../schema";
import type { ModuleStoreWrite } from "../store";
import { SqliteModuleStore } from "../store/sqlite";
import {
  moduleInstallations,
  moduleManifests,
  modulePositions,
  modules,
} from "../store/tables";
import { libsqlDatabases } from "./helpers/sqlite";

const memory = libsqlDatabases("memory");
const files = libsqlDatabases("file");

/** What SQLite says when a lock it needs is held. */
const LOCKED = /locked|busy/i;

/** Text SQLite does not give back intact, each made from a plain string. */
const UNSTORABLE: [string, (plain: string) => string][] = [
  ["U+0000", (plain) => `${plain}\u0000tail`],
  ["a lone high surrogate", (plain) => `${plain}\uD800`],
  ["a lone low surrogate", (plain) => `\uDC00${plain}`],
];

const at = (iso: string) => new Date(iso);

function module(id: string, artifact = `artifact-${id}`): Module {
  return { artifactId: artifact as ArtifactId, id: id as ModuleId };
}

function manifest(
  content: string,
  owner: Module,
  value: Readonly<Record<string, unknown>> = { format: "test" }
): StoredManifest {
  return {
    contentId: content as ContentId,
    manifest: value as unknown as ModuleManifest,
    moduleId: owner.id,
  };
}

function grant(
  capability: string,
  overrides: Partial<InstallationGrant> = {}
): InstallationGrant {
  return {
    capability,
    constraintsDigest: `digest-${capability}`,
    createdAt: at("2026-11-01T00:00:00.123Z"),
    version: 1,
    ...overrides,
  };
}

function installation(
  id: string,
  owner: Module,
  overrides: {
    readonly grants?: readonly InstallationGrant[];
    readonly installation?: Partial<Installation>;
  } = {}
): StoredInstallation {
  return {
    grants: overrides.grants ?? [],
    installation: {
      containerId: null,
      contentId: `content-${id}` as ContentId,
      createdAt: at("2026-11-01T00:00:00.000Z"),
      generation: 0,
      id: id as InstallationId,
      moduleId: owner.id,
      startAttempts: 0,
      status: "disabled",
      updatedAt: at("2026-11-01T00:00:00.000Z"),
      ...overrides.installation,
    },
  };
}

async function storeOn(
  options: { readonly onCommit?: () => void } = {}
): Promise<SqliteModuleStore> {
  return new SqliteModuleStore({
    database: await memory.open(),
    ...(options.onCommit === undefined
      ? {}
      : {
          onCommit: () => {
            options.onCommit?.();
            return Promise.resolve();
          },
        }),
    scope: "s",
  });
}

async function held(store: SqliteModuleStore) {
  return {
    installations: (await store.listInstallations({ limit: 10_000 })).items,
    manifests: await store.listManifests(),
    modules: (await store.listModules({ limit: 10_000 })).items,
  };
}

/** A host table, written in the same transaction as a commit. */
const changes = sqliteTable("changes", {
  write: text("write", { mode: "json" }).notNull(),
});

describe("SqliteModuleStore", () => {
  test("refuses an empty scope", async () => {
    const database = await memory.open();
    expect(() => new SqliteModuleStore({ database, scope: "" })).toThrow(
      RangeError
    );
  });

  test.each(UNSTORABLE)("refuses a scope holding %s", async (_kind, bad) => {
    const database = await memory.open();
    expect(
      () => new SqliteModuleStore({ database, scope: bad("scope") })
    ).toThrow(RangeError);
  });

  test.each(UNSTORABLE)(
    "refuses, before writing anything, %s in a text field, naming it",
    async (_kind, bad) => {
      let committed = 0;
      const store = await storeOn({
        onCommit: () => {
          committed += 1;
        },
      });
      const kept = module("kept");
      await store.commit({
        putInstallations: [installation("kept", kept)],
        putModules: [kept],
      });
      const before = await held(store);
      const refusals: [ModuleStoreWrite, string][] = [
        [{ putModules: [module(bad("id"), "artifact")] }, "putModules[0].id"],
        [
          { putModules: [kept, module("b", bad("artifact"))] },
          "putModules[1].artifactId",
        ],
        [
          { putManifests: [manifest(bad("content"), kept)] },
          "putManifests[0].contentId",
        ],
        [
          { putManifests: [manifest("c", module(bad("owner")))] },
          "putManifests[0].moduleId",
        ],
        ...(
          ["id", "moduleId", "contentId", "containerId", "status"] as const
        ).map((field): [ModuleStoreWrite, string] => [
          {
            deleteModules: [kept.id],
            putInstallations: [
              installation("i", kept, {
                installation: { [field]: bad(field) },
              }),
            ],
          },
          `putInstallations[0].installation.${field}`,
        ]),
      ];
      for (const [write, field] of refusals) {
        await expect(store.commit(write)).rejects.toThrow(
          `cannot store ${field}: text holding U+0000 or a lone surrogate`
        );
        // A commit through a transaction's view is checked the same way.
        await expect(
          store.transaction((view) => view.commit(write))
        ).rejects.toThrow(`cannot store ${field}`);
      }
      await expect(
        new ModuleRegistry({ store }).registerModule({
          module: module(bad("via registry")),
        })
      ).rejects.toThrow(RangeError);

      expect(committed).toBe(1);
      expect(await held(store)).toEqual(before);
      // JSON columns escape it, so a manifest and a Grant keep it.
      const json = installation("json", kept, {
        grants: [grant(bad("capability"), { constraintsDigest: bad("d") })],
      });
      const retained = manifest("json", kept, { [bad("key")]: bad("value") });
      await store.commit({
        putInstallations: [json],
        putManifests: [retained],
      });
      expect(await store.getInstallation(json.installation.id)).toEqual(json);
      expect(await store.getManifest(retained.contentId)).toEqual(retained);
    }
  );

  // What every store refuses (a field of the wrong type, data that is not
  // plain) is in the conformance suite; these are SQLite's own limits.
  test("refuses, before writing anything, a value SQLite or JSON would give back changed, naming it", async () => {
    let committed = 0;
    const store = await storeOn({
      onCommit: () => {
        committed += 1;
      },
    });
    const owner = module("owner");
    const shaped = (overrides: Parameters<typeof installation>[2]) => ({
      putInstallations: [installation("i", owner, overrides)],
    });
    const refusals: [ModuleStoreWrite, string][] = [
      [
        shaped({ installation: { createdAt: new Date(Number.NaN) } }),
        "putInstallations[0].installation.createdAt: an invalid Date is not a valid Date",
      ],
      [
        shaped({ grants: [grant("g", { createdAt: new Date(Number.NaN) })] }),
        "putInstallations[0].grants[0].createdAt",
      ],
      ...[-0, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53].map(
        (value): [ModuleStoreWrite, string] => [
          shaped({ installation: { generation: value } }),
          "putInstallations[0].installation.generation",
        ]
      ),
      [
        shaped({ installation: { startAttempts: -0 } }),
        "putInstallations[0].installation.startAttempts: -0 does not read back intact",
      ],
      ...[-0, Number.NaN].map((value): [ModuleStoreWrite, string] => [
        shaped({ grants: [grant("g", { version: value })] }),
        "putInstallations[0].grants[0].version",
      ]),
      [
        {
          putManifests: [
            manifest("m", owner, { nested: { list: [1, Number.NaN] } }),
          ],
        },
        "putManifests[0].manifest.nested.list[1]: NaN",
      ],
      [
        { putManifests: [manifest("m", owner, { "odd key": -0 })] },
        'putManifests[0].manifest["odd key"]: -0',
      ],
    ];
    for (const [write, message] of refusals) {
      await expect(store.commit(write)).rejects.toThrow(
        `SqliteModuleStore cannot store ${message}`
      );
      await expect(
        store.transaction((view) => view.commit(write))
      ).rejects.toThrow(RangeError);
    }

    expect(committed).toBe(0);
    expect(await held(store)).toEqual({
      installations: [],
      manifests: [],
      modules: [],
    });
  });

  test.each([
    ["memory", memory],
    ["file", files],
  ] as const)(
    "gives every record back exactly as it was put (%s)",
    async (_location, databases) => {
      const database = await databases.open();
      const store = new SqliteModuleStore({ database, scope: "s" });
      const owner = module("owner");
      const records = [
        installation("earliest", owner, {
          installation: {
            createdAt: new Date(-8.64e15),
            generation: Number.MAX_SAFE_INTEGER,
            startAttempts: 0,
            updatedAt: new Date(8.64e15),
          },
        }),
        installation("fractional", owner, {
          grants: [
            // Kept in the order put, not sorted.
            grant("z.last", { version: 2.5 }),
            grant("a.first", { createdAt: new Date(-1), version: -3 }),
          ],
          installation: {
            containerId: "",
            createdAt: at("1969-12-31T23:59:59.999Z"),
            generation: 1.5,
            startAttempts: -2,
            status: "failed",
            updatedAt: at("2026-11-01T12:34:56.789Z"),
          },
        }),
        installation("running", owner, {
          installation: { containerId: "container-ü-🧪", status: "active" },
        }),
      ];
      const retained = manifest("m", owner, {
        ["__proto__"]: { own: true },
        empty: { array: [], object: {} },
        nested: { list: [0, -2.5, 1e300, "", "ü🧪", null, true, false] },
      });
      await store.commit({
        putInstallations: records,
        putManifests: [retained],
        putModules: [owner],
      });

      const reread = new SqliteModuleStore({
        database: await (databases === files
          ? files.reopen(database)
          : Promise.resolve(database)),
        scope: "s",
      });
      for (const record of records) {
        const read = await reread.getInstallation(record.installation.id);
        expect(read).toEqual(record);
        expect(read?.installation.createdAt.getTime()).toBe(
          record.installation.createdAt.getTime()
        );
        expect(read?.grants.map((g) => g.createdAt.getTime())).toEqual(
          record.grants.map((g) => g.createdAt.getTime())
        );
      }
      expect(
        (
          await reread.getInstallation(
            records[0]?.installation.id as InstallationId
          )
        )?.installation.containerId
      ).toBeNull();
      const readManifest = await reread.getManifest(retained.contentId);
      expect(readManifest).toEqual(retained);
      expect(Object.hasOwn(readManifest?.manifest as object, "__proto__")).toBe(
        true
      );
      expect(await reread.getModule(owner.id)).toEqual(owner);
    }
  );

  test.each(UNSTORABLE)(
    "a read, filter or delete by a key holding %s touches no other row",
    async (_kind, bad) => {
      const store = await storeOn();
      // What a lone surrogate turns into when bound: U+FFFD on Node, nothing
      // on Bun; and what a NUL cuts text to.
      const lookalikes = ["�", "", "x"].map((id) => module(id, id));
      await store.commit({
        putInstallations: lookalikes.map((owner) =>
          installation(owner.id, owner)
        ),
        putManifests: lookalikes.map((owner) => manifest(owner.id, owner)),
        putModules: lookalikes,
      });
      const before = await held(store);
      const key = bad("x").slice(0, 2);

      for (const candidate of [key, bad("")]) {
        expect(await store.getModule(candidate as ModuleId)).toBeNull();
        expect(await store.getManifest(candidate as ContentId)).toBeNull();
        expect(
          await store.getInstallation(candidate as InstallationId)
        ).toBeNull();
        expect(
          await store.listModules({
            artifactId: candidate as ArtifactId,
            limit: 10,
          })
        ).toEqual({ items: [] });
        expect(
          await store.listInstallations({
            limit: 10,
            moduleId: candidate as ModuleId,
          })
        ).toEqual({ items: [] });
        expect(
          await store.listManifests({ moduleId: candidate as ModuleId })
        ).toEqual([]);
        await store.commit({
          deleteInstallations: [candidate as InstallationId],
          deleteManifests: [candidate as ContentId],
          deleteModules: [candidate as ModuleId],
        });
      }
      expect(await held(store)).toEqual(before);
    }
  );

  test("onCommit runs inside the commit, after the store's statements, with the whole write", async () => {
    const database = await memory.open();
    await database.run(sql`CREATE TABLE "changes" ("write" text NOT NULL)`);
    const seen: { readonly rows: number; readonly write: ModuleStoreWrite }[] =
      [];
    const store = new SqliteModuleStore({
      database,
      onCommit: async (transaction, write) => {
        const rows = await transaction
          .select()
          .from(modules)
          .where(eq(modules.scope, "host"));
        seen.push({ rows: rows.length, write });
        await transaction
          .insert(changes)
          .values({ write: { modules: write.putModules } });
      },
      scope: "host",
    });
    const registered = await new ModuleRegistry({ store }).registerModule({
      module: module("a"),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.rows).toBe(1);
    expect(seen[0]?.write).toEqual({ putModules: [registered] });
    const [recorded] = await database.select().from(changes);
    expect(recorded?.write).toEqual({ modules: [registered] });
  });

  test.each([
    ["memory", memory],
    ["file", files],
  ] as const)(
    "onCommit receives the write as it stood when commit was called, not the caller's object (%s)",
    async (_location, databases) => {
      const received: ModuleStoreWrite[] = [];
      const store = new SqliteModuleStore({
        database: await databases.open(),
        onCommit: (_transaction, write) => {
          received.push(write);
          return Promise.resolve();
        },
        scope: "host",
      });
      const writeOf = (name: string) => {
        const owner = module(name);
        return {
          putInstallations: [
            installation(name, owner, { grants: [grant("g")] }),
          ],
          putManifests: [manifest(name, owner, { list: ["x"] })],
          putModules: [owner],
        };
      };
      const change = (write: ReturnType<typeof writeOf>) => {
        for (const put of write.putInstallations) {
          put.installation.createdAt.setTime(0);
          Object.assign(put.installation, { status: "failed" });
          put.grants[0]?.createdAt.setTime(0);
        }
        for (const put of write.putManifests) {
          (put.manifest as unknown as { list: string[] }).list.push("changed");
        }
        write.putModules.push(module("late"));
      };

      // Queued behind a transaction, then through a transaction's view.
      const release = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const running = store.transaction(async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const queued = writeOf("queued");
      const expected = [structuredClone(queued)];
      const landing = store.commit(queued);
      change(queued);
      release.resolve();
      await Promise.all([running, landing]);
      const viewed = writeOf("viewed");
      expected.push(structuredClone(viewed));
      await store.transaction(async (view) => {
        const committed = view.commit(viewed);
        change(viewed);
        await committed;
      });

      expect(received).toEqual(expected);
      expect(received[0]).not.toBe(queued);
      expect(received[1]).not.toBe(viewed);
      expect((await store.listModules({ limit: 10 })).items).toEqual(
        received.flatMap((write) => write.putModules ?? [])
      );
    }
  );

  test("onCommit calling the store it belongs to is refused at once", async () => {
    const outcomes: string[] = [];
    let store: SqliteModuleStore | undefined;
    const attempt = async (call: () => Promise<unknown>) => {
      const result = await Promise.race([
        call().then(
          () => "resolved",
          (error: unknown) => String(error)
        ),
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("still pending"), 1000);
        }),
      ]);
      outcomes.push(result);
    };
    store = new SqliteModuleStore({
      database: await memory.open(),
      onCommit: async (transaction) => {
        const outer = store as SqliteModuleStore;
        await attempt(() => outer.getModule("a" as ModuleId));
        await attempt(() => outer.getManifest("a" as ContentId));
        await attempt(() => outer.getInstallation("a" as InstallationId));
        await attempt(() => outer.listModules({ limit: 1 }));
        await attempt(() => outer.listInstallations({ limit: 1 }));
        await attempt(() => outer.listManifests());
        await attempt(() => outer.commit({}));
        await attempt(() => outer.transaction(() => Promise.resolve()));
        // The transaction it is given is the way in.
        await transaction.select().from(modules);
      },
      scope: "s",
    });

    const registered = await new ModuleRegistry({ store }).registerModule({
      module: module("a"),
    });

    expect(outcomes).toHaveLength(8);
    for (const outcome of outcomes) {
      expect(outcome).toContain("ReentrantCallError");
      expect(outcome).toContain("the transaction passed to onCommit");
    }
    expect(await store.getModule(registered.id)).toEqual(registered);
  });

  test("a throwing onCommit rolls back the store's statements and its own", async () => {
    const database = await memory.open();
    await database.run(sql`CREATE TABLE "changes" ("write" text NOT NULL)`);
    const store = new SqliteModuleStore({
      database,
      onCommit: async (transaction, write) => {
        await transaction.insert(changes).values({ write });
        throw new Error("host refused");
      },
      scope: "host",
    });
    const owner = module("a");

    await expect(
      store.commit({
        putInstallations: [installation("a", owner)],
        putManifests: [manifest("a", owner)],
        putModules: [owner],
      })
    ).rejects.toThrow("host refused");
    expect(await held(store)).toEqual({
      installations: [],
      manifests: [],
      modules: [],
    });
    expect(await database.select().from(changes)).toEqual([]);
  });

  test("a host transaction can be the database, so a commit joins it", async () => {
    const database = await memory.open();
    const owner = module("a");

    await expect(
      database.transaction(async (transaction) => {
        const joined = new SqliteModuleStore({
          database: transaction,
          scope: "s",
        });
        await joined.commit({ putModules: [owner] });
        expect(await joined.getModule(owner.id)).toEqual(owner);
        throw new Error("host rolled back");
      })
    ).rejects.toThrow("host rolled back");
    expect(
      await new SqliteModuleStore({ database, scope: "s" }).getModule(owner.id)
    ).toBeNull();
  });

  test("one write can carry thousands of records of every kind", async () => {
    const store = await storeOn();
    const owners = Array.from({ length: 4000 }, (_, index) =>
      module(`m${index}`)
    );
    const installations = owners.map((owner) =>
      installation(owner.id, owner, { grants: [grant("g")] })
    );
    const manifests = owners.map((owner) => manifest(owner.id, owner));
    await store.commit({
      putInstallations: installations,
      putManifests: manifests,
      putModules: owners,
    });
    const stored = await held(store);
    expect(stored.modules.map(({ id }) => id)).toEqual(
      owners.map(({ id }) => id)
    );
    expect(stored.installations).toEqual(installations);
    expect(stored.manifests).toHaveLength(manifests.length);

    await store.commit({
      deleteInstallations: installations.map(
        (record) => record.installation.id
      ),
      deleteManifests: manifests.map((record) => record.contentId),
      deleteModules: owners.map(({ id }) => id),
    });
    expect(await held(store)).toEqual({
      installations: [],
      manifests: [],
      modules: [],
    });
  });

  test("never hands a position out twice across reopening the file", async () => {
    const first = await files.open();
    const store = new SqliteModuleStore({ database: first, scope: "s" });
    await store.commit({ putModules: ["a", "b", "c"].map((id) => module(id)) });
    const page = await store.listModules({ limit: 2 });
    await store.commit({
      deleteModules: ["b", "c"].map((id) => id as ModuleId),
    });

    const reopened = new SqliteModuleStore({
      database: await files.reopen(first),
      scope: "s",
    });
    await reopened.commit({ putModules: [module("d")] });
    expect(
      await reopened.listModules({ after: page.next as number, limit: 2 })
    ).toEqual({ items: [module("d")] });
  });

  test.each([
    ["a put", { putModules: [module("d")] }],
    ["a delete-only commit", { deleteModules: ["c" as ModuleId] }],
  ] as const)(
    "a scope with rows but no counter yet starts past them, from %s",
    async (_first, write: ModuleStoreWrite) => {
      const database = await memory.open();
      // Rows a store wrote before it kept a counter.
      await database.insert(modules).values(
        ["a", "b", "c"].map((id, index) => ({
          ...module(id),
          position: index + 1,
          scope: "s",
        }))
      );
      const store = new SqliteModuleStore({ database, scope: "s" });
      await store.commit(write);
      await store.commit({
        deleteModules: ["c" as ModuleId],
        putModules: [module("e")],
      });

      const positions = await database
        .select({ id: modules.id, position: modules.position })
        .from(modules)
        .where(eq(modules.scope, "s"));
      const e = positions.find((row) => row.id === "e");
      // Never 3, the position `c` held, nor any other a row has had.
      expect(e?.position).toBeGreaterThan(3);
      expect(new Set(positions.map((row) => row.position)).size).toBe(
        positions.length
      );
    }
  );

  test("a write that fails part-way through its transaction leaves nothing", async () => {
    const database = await memory.open();
    // The installations table is gone, so the commit fails after it has
    // written the Module and the manifest, inside its transaction.
    await database.run(sql`DROP TABLE "module_installations"`);
    const store = new SqliteModuleStore({ database, scope: "s" });
    const owner = module("a");

    await expect(
      store.commit({
        putInstallations: [installation("a", owner)],
        putManifests: [manifest("a", owner)],
        putModules: [owner],
      })
    ).rejects.toThrow();
    expect(await store.getModule(owner.id)).toBeNull();
    expect(await store.getManifest("a" as ContentId)).toBeNull();
    expect(await store.listModules({ limit: 10 })).toEqual({ items: [] });
  });

  test('states its durability: over a host\'s transaction it is "host", and refuses "commit" there', async () => {
    const database = await memory.open();
    expect(new SqliteModuleStore({ database, scope: "s" }).durability).toBe(
      "commit"
    );
    expect(
      new SqliteModuleStore({ database, durability: "host", scope: "s" })
        .durability
    ).toBe("host");
    await database
      .transaction(async (transaction) => {
        expect(
          new SqliteModuleStore({ database: transaction, scope: "s" })
            .durability
        ).toBe("host");
        expect(
          () =>
            new SqliteModuleStore({
              database: transaction,
              durability: "commit",
              scope: "s",
            })
        ).toThrow("durability cannot be");
        throw new Error("host rolled back");
      })
      .catch(() => undefined);
  });

  test("a transaction holds the write lock against another connection", async () => {
    const database = await files.open();
    const store = new SqliteModuleStore({ database, scope: "s" });
    const other = new SqliteModuleStore({
      database: files.connect(database, { busyTimeout: 50 }),
      scope: "s",
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const running = store.transaction(async (view) => {
      await view.commit({ putModules: [module("inside")] });
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    await expect(
      other.commit({ putModules: [module("outside")] })
    ).rejects.toThrow(LOCKED);
    release.resolve();
    await running;

    expect(
      (await store.listModules({ limit: 10 })).items.map(({ id }) => id)
    ).toEqual(["inside"]);
  });

  test("two registries over one store cannot both create an Installation", async () => {
    const store = await storeOn();
    const owner = module("a");
    await store.commit({ putModules: [owner] });
    const version = {
      artifactId: owner.artifactId,
      contentId: "content" as ContentId,
      moduleId: owner.id,
    };
    const input = {
      id: "shared" as InstallationId,
      now: at("2026-11-01T00:00:00.000Z"),
      version,
    };

    const results = await Promise.allSettled([
      new ModuleRegistry({ store }).createInstallation(input),
      new ModuleRegistry({ store }).createInstallation(input),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect((await store.listInstallations({ limit: 10 })).items).toHaveLength(
      1
    );
  });
});

describe("module tables", () => {
  test("hold each record field for field, plus scope and position", () => {
    expect(Object.keys(getTableColumns(modulePositions)).sort()).toEqual([
      "next",
      "scope",
    ]);
    expect(columnsOf(modules)).toEqual(fieldsOf(moduleSchema.unwrap().shape));
    expect(columnsOf(moduleManifests)).toEqual(
      fieldsOf(storedManifestSchema.unwrap().shape)
    );
    expect(columnsOf(moduleInstallations)).toEqual({
      ...fieldsOf(installationSchema.unwrap().shape),
      grants: storedInstallationSchema.unwrap().shape.grants.safeParse(null)
        .success,
    });
  });
});

/** Each record column, by field name, and whether it takes `null`. */
function columnsOf(
  table: typeof modules | typeof moduleManifests | typeof moduleInstallations
) {
  const { position, scope, ...columns } = getTableColumns(table);
  expect([position.notNull, scope.notNull]).toEqual([true, true]);
  return Object.fromEntries(
    Object.entries(columns).map(([key, column]) => [key, !column.notNull])
  );
}

/** Each schema field and whether it accepts `null`. */
function fieldsOf(shape: Readonly<Record<string, z.ZodType>>) {
  return Object.fromEntries(
    Object.entries(shape).map(([key, field]) => [
      key,
      field.safeParse(null).success,
    ])
  );
}
