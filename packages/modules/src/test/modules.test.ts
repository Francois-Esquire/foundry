import type { ArtifactId, ContentId } from "@foundry/artifacts";
import { describe, expect, it } from "vitest";

import {
  createDisabledInstallation,
  defineModule,
  defineModuleVersion,
  installationIdSchema,
  moduleIdSchema,
} from "../domain";
import { ModuleStoreConflictError } from "../errors";
import { Modules, type ModulesOptions } from "../modules";
import type { ModuleStore } from "../store";
import { MemoryModuleStore } from "../store/memory";
import { SqliteModuleStore } from "../store/sqlite";
import { describeModules } from "./helpers/describe-modules";
import { moduleFixture, VALID_MANIFEST } from "./helpers/module-fixture";
import { libsqlDatabases } from "./helpers/sqlite";

interface StoreRun {
  readonly name: string;
  readonly open: () => Promise<{
    readonly reopen: () => Promise<ModuleStore>;
    readonly store: ModuleStore;
  }>;
}

const memoryDatabases = libsqlDatabases("memory");
const fileDatabases = libsqlDatabases("file");

const RUNS: readonly StoreRun[] = [
  {
    name: "MemoryModuleStore",
    open: () => {
      const store = new MemoryModuleStore();
      return Promise.resolve({ reopen: () => Promise.resolve(store), store });
    },
  },
  {
    name: "SqliteModuleStore on libSQL (memory)",
    async open() {
      const store = new SqliteModuleStore({
        database: await memoryDatabases.open(),
        scope: "workspace",
      });
      return { reopen: () => Promise.resolve(store), store };
    },
  },
  {
    name: "SqliteModuleStore on libSQL (file)",
    async open() {
      let database = await fileDatabases.open();
      return {
        async reopen() {
          database = await fileDatabases.reopen(database);
          return new SqliteModuleStore({ database, scope: "workspace" });
        },
        store: new SqliteModuleStore({ database, scope: "workspace" }),
      };
    },
  },
];

for (const run of RUNS) {
  let opened: Awaited<ReturnType<StoreRun["open"]>> | undefined;
  async function freshRegistry(
    options: Omit<ModulesOptions, "store"> = {}
  ): Promise<Modules> {
    opened = await run.open();
    return new Modules({ ...options, store: opened.store });
  }

  async function fixture() {
    const { artifact, content } = await moduleFixture();
    const module = defineModule({
      artifact,
      id: moduleIdSchema.parse("module-1"),
    });
    const version = defineModuleVersion({
      artifact,
      content,
      manifest: VALID_MANIFEST,
      module,
    });
    const alternate = await moduleFixture({
      artifactId: artifact.id,
      tag: "1.1.0",
    });
    const alternateVersion = defineModuleVersion({
      artifact: alternate.artifact,
      content: alternate.content,
      manifest: VALID_MANIFEST,
      module,
    });
    const installation = createDisabledInstallation({
      id: installationIdSchema.parse("installation-1"),
      now: new Date("2026-08-08T00:00:00.000Z"),
      version,
    });
    const store = await freshRegistry();
    await store.registerModule({ module });
    return { alternateVersion, installation, module, store, version };
  }

  describeModules(run.name, async () => {
    const { installation, version, alternateVersion, store } = await fixture();
    const reopen = opened?.reopen;
    return {
      alternateVersion,
      containerId: "container-1",
      installation: {
        id: installation.id,
        now: installation.createdAt,
        version,
      },
      reopen: async () =>
        reopen === undefined ? store : new Modules({ store: await reopen() }),
      store,
    };
  });

  describe(`Modules over ${run.name}`, () => {
    it("with artifactOfContent, refuses a version whose Content is unknown or another Artifact's", async () => {
      const { artifact, content } = await moduleFixture();
      const other = await moduleFixture();
      const owners = new Map<string, ArtifactId>([
        [content.id, artifact.id],
        [other.content.id, other.artifact.id],
      ]);
      const registry = await freshRegistry({
        artifactOfContent: (contentId) =>
          Promise.resolve(owners.get(contentId) ?? null),
      });
      const module = defineModule({
        artifact,
        id: moduleIdSchema.parse("module-1"),
      });
      await registry.registerModule({ module });
      const now = new Date("2026-08-08T00:00:00.000Z");
      const version = {
        artifactId: artifact.id,
        contentId: content.id,
        moduleId: module.id,
      };
      const madeUp = { ...version, contentId: "made-up" as ContentId };
      const foreign = { ...version, contentId: other.content.id };

      await expect(
        registry.createInstallation({
          id: installationIdSchema.parse("made-up"),
          now,
          version: madeUp,
        })
      ).rejects.toThrow("Content made-up does not exist");
      await expect(
        registry.createInstallation({
          id: installationIdSchema.parse("foreign"),
          now,
          version: foreign,
        })
      ).rejects.toThrow(
        `Content ${other.content.id} belongs to Artifact ${other.artifact.id}, not ${artifact.id}`
      );
      const created = await registry.createInstallation({
        id: installationIdSchema.parse("real"),
        now,
        version,
      });
      for (const selected of [madeUp, foreign]) {
        await expect(
          registry.selectInstallationVersion({
            expectedGeneration: 0,
            installationId: created.id,
            now,
            version: selected,
          })
        ).rejects.toBeInstanceOf(ModuleStoreConflictError);
      }
      await expect(
        registry.transaction((bound) =>
          bound.createInstallation({
            id: installationIdSchema.parse("bound"),
            now,
            version: madeUp,
          })
        )
      ).rejects.toThrow("does not exist");
      expect(
        (await registry.listInstallations()).items.map(({ id }) => id)
      ).toEqual(["real"]);
    });

    it("registers a Module identity before it has a version", async () => {
      const { artifact, content } = await moduleFixture();
      const module = defineModule({
        artifact,
        id: moduleIdSchema.parse("module-draft"),
      });
      const store = await freshRegistry();

      await expect(store.registerModule({ module })).resolves.toEqual(module);
      await expect(store.loadModule(module.id)).resolves.toEqual(module);
      await expect(store.loadRetainedManifest(content.id)).resolves.toBeNull();
    });

    it("refuses a Module re-registered against another Artifact and an Artifact claimed twice", async () => {
      const { module, store } = await fixture();
      const other = await moduleFixture();
      await expect(store.registerModule({ module })).resolves.toEqual(module);
      await expect(
        store.registerModule({
          module: { ...module, artifactId: other.artifact.id },
        })
      ).rejects.toBeInstanceOf(ModuleStoreConflictError);
      await expect(
        store.registerModule({
          module: { ...module, id: moduleIdSchema.parse("module-2") },
        })
      ).rejects.toBeInstanceOf(ModuleStoreConflictError);
    });

    it("refuses to select a version of another registered Module", async () => {
      const { installation, version, store } = await fixture();
      const other = await moduleFixture();
      const otherModule = defineModule({
        artifact: other.artifact,
        id: moduleIdSchema.parse("module-2"),
      });
      await store.registerModule({ module: otherModule });
      await store.createInstallation({
        id: installation.id,
        now: installation.createdAt,
        version,
      });
      await expect(
        store.selectInstallationVersion({
          expectedGeneration: 0,
          installationId: installation.id,
          now: installation.createdAt,
          version: defineModuleVersion({
            artifact: other.artifact,
            content: other.content,
            manifest: VALID_MANIFEST,
            module: otherModule,
          }),
        })
      ).rejects.toBeInstanceOf(ModuleStoreConflictError);
      expect(
        (await store.loadGatewayContext(installation.id))?.installation
      ).toMatchObject({ contentId: version.contentId, generation: 0 });
    });

    it("rolls back a lifecycle write and its grants together", async () => {
      const { installation, version, store } = await fixture();
      await store.createInstallation({
        id: installation.id,
        now: installation.createdAt,
        version,
      });

      await expect(
        store.transaction(async (registry) => {
          await registry.beginInstallationTransition({
            expectedGeneration: 0,
            installationId: installation.id,
            now: new Date("2026-08-08T00:01:00.000Z"),
            status: "starting",
          });
          await registry.replaceInstallationGrants({
            expectedGeneration: 1,
            grants: [
              {
                capability: "host.agents.run",
                constraintsDigest: "abc",
                version: 1,
              },
            ],
            installationId: installation.id,
            now: new Date("2026-08-08T00:01:00.000Z"),
          });
          throw new Error("injected lifecycle failure");
        })
      ).rejects.toThrow("injected lifecycle failure");
      expect(await store.loadGatewayContext(installation.id)).toMatchObject({
        grants: [],
        installation: { generation: 0, status: "disabled" },
      });
    });
  });
}

function withoutTransaction(store: ModuleStore): ModuleStore {
  return {
    commit: (write) => store.commit(write),
    getInstallation: (id) => store.getInstallation(id),
    getManifest: (contentId) => store.getManifest(contentId),
    getModule: (id) => store.getModule(id),
    listInstallations: (query) => store.listInstallations(query),
    listManifests: (query) => store.listManifests(query),
    listModules: (query) => store.listModules(query),
  };
}

describe("Modules over a store without transaction", () => {
  async function registered() {
    const { artifact, content } = await moduleFixture();
    const module = defineModule({
      artifact,
      id: moduleIdSchema.parse("module-1"),
    });
    const version = defineModuleVersion({
      artifact,
      content,
      manifest: VALID_MANIFEST,
      module,
    });
    const registry = new Modules({
      store: withoutTransaction(new MemoryModuleStore()),
    });
    await registry.registerModule({ module });
    return { registry, version };
  }

  it("runs one command at a time, so two cannot both pass a check", async () => {
    const { registry, version } = await registered();
    const input = {
      id: installationIdSchema.parse("shared"),
      now: new Date("2026-08-08T00:00:00.000Z"),
      version,
    };

    const results = await Promise.allSettled([
      registry.createInstallation(input),
      registry.createInstallation(input),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect((await registry.listInstallations()).items).toHaveLength(1);
  });

  it("refuses a command to itself from inside its own transaction, at once", async () => {
    const { registry, version } = await registered();
    const outcome = await registry.transaction(async (inner) => {
      const refused = await registry
        .createInstallation({
          id: installationIdSchema.parse("outer"),
          now: new Date("2026-08-08T00:00:00.000Z"),
          version,
        })
        .then(
          () => "resolved",
          (error: unknown) => String(error)
        );
      await inner.createInstallation({
        id: installationIdSchema.parse("inner"),
        now: new Date("2026-08-08T00:00:00.000Z"),
        version,
      });
      return refused;
    });

    expect(outcome).toContain(
      "Modules was called from inside its own transaction; use the Modules instance passed to the transaction's work instead"
    );
    expect((await registry.listInstallations()).items).toHaveLength(1);
  });

  it("uses listModulesPage and listInstallationsPage without draining listModules/listInstallations", async () => {
    const base = new MemoryModuleStore();
    const counts = {
      listInstallations: 0,
      listInstallationsPage: 0,
      listModules: 0,
      listModulesPage: 0,
    };
    const track = (inner: ModuleStore): ModuleStore => {
      const wrapped: ModuleStore = {
        commit: (write) => inner.commit(write),
        getInstallation: (id) => inner.getInstallation(id),
        getManifest: (contentId) => inner.getManifest(contentId),
        getModule: (id) => inner.getModule(id),
        listInstallations: (query) => {
          counts.listInstallations += 1;
          return inner.listInstallations(query);
        },
        listInstallationsPage: (query) => {
          counts.listInstallationsPage += 1;
          return (
            inner.listInstallationsPage?.(query) ??
            Promise.resolve({ items: [] })
          );
        },
        listManifests: (query) => inner.listManifests(query),
        listModules: (query) => {
          counts.listModules += 1;
          return inner.listModules(query);
        },
        listModulesPage: (query) => {
          counts.listModulesPage += 1;
          return (
            inner.listModulesPage?.(query) ?? Promise.resolve({ items: [] })
          );
        },
      };
      const transaction = inner.transaction?.bind(inner);
      return transaction === undefined
        ? wrapped
        : {
            ...wrapped,
            transaction: <T>(work: (view: ModuleStore) => Promise<T>) =>
              transaction((view) => work(track(view))),
          };
    };
    const registry = new Modules({ store: track(base) });
    const fixtureA = await moduleFixture();
    const fixtureB = await moduleFixture();
    const modA = defineModule({
      artifact: fixtureA.artifact,
      id: moduleIdSchema.parse("alpha"),
    });
    const modB = defineModule({
      artifact: fixtureB.artifact,
      id: moduleIdSchema.parse("beta"),
    });
    await registry.registerModule({ module: modB });
    await registry.registerModule({ module: modA });
    await registry.createInstallation({
      id: installationIdSchema.parse("inst-1"),
      now: new Date("2026-08-08T00:00:00.000Z"),
      version: defineModuleVersion({
        artifact: fixtureA.artifact,
        content: fixtureA.content,
        manifest: VALID_MANIFEST,
        module: modA,
      }),
    });
    counts.listModules = 0;
    counts.listInstallations = 0;

    const modsPage = await registry.listModules({ limit: 1 });
    expect(modsPage).toEqual({
      items: [modA],
      nextCursor: modA.id,
      total: 2,
    });
    const instPage = await registry.listInstallations({
      limit: 1,
      moduleId: modA.id,
    });
    expect(instPage.items.map((item) => item.id)).toEqual(["inst-1"]);
    expect(counts.listModulesPage).toBe(1);
    expect(counts.listInstallationsPage).toBe(1);
    expect(counts.listModules).toBe(0);
    expect(counts.listInstallations).toBe(0);
  });

  it("falls back to draining listModules/listInstallations for minimal stores without *Page", async () => {
    const { registry, version } = await registered();
    await registry.createInstallation({
      id: installationIdSchema.parse("inst-fallback"),
      now: new Date("2026-08-08T00:00:00.000Z"),
      version,
    });
    expect((await registry.listModules({ limit: 1 })).items).toHaveLength(1);
    expect(
      (await registry.listInstallations({ limit: 1 })).items.map((i) => i.id)
    ).toEqual(["inst-fallback"]);
  });
});
