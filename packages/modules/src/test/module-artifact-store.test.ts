import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ArtifactManager,
  type ArtifactStore,
  artifactIdSchema,
  InMemoryArtifactStore,
} from "@foundry/artifacts";
import { JsonArtifactStore } from "@foundry/artifacts/node";
import { describe, expect, it } from "vitest";

import { MODULE_MIME } from "../constants";
import {
  defineModule,
  defineModuleVersion,
  installationIdSchema,
  moduleIdSchema,
} from "../domain";
import {
  type ArtifactModuleStoreOptions,
  createArtifactModuleStore,
} from "../store/artifact";
import { ModuleStoreCorruptionError } from "../store/contract";
import { describeModuleStoreConformance } from "../testing/module-store-conformance";
import { PROGRAM_FILES, VALID_MANIFEST } from "./helpers/module-fixture";

const NOW = new Date("2026-08-08T00:00:00.000Z");
const FETCH = {
  capability: "host.network.fetch",
  constraintsDigest: "digest-fetch",
  version: 1,
} as const;

/** A registered Module with two frozen versions, over `store`. */
async function seed(
  store: ArtifactStore,
  options: ArtifactModuleStoreOptions = {}
) {
  const artifacts = new ArtifactManager({ store });
  const modules = createArtifactModuleStore(artifacts, options);
  const created = await artifacts.create({
    entries: PROGRAM_FILES,
    freeze: { tag: "1.0.0" },
    id: artifactIdSchema.parse("module-artifact"),
    name: "Notes",
    type: MODULE_MIME,
  });
  if (!created.content) {
    throw new Error("Expected Content");
  }
  const first = created.content;
  const revised = await artifacts.revise({
    artifactId: created.id,
    contentId: first.id,
    expectedUpdatedAt: first.updatedAt,
  });
  await artifacts.freeze(revised.id, { tag: "1.1.0" });
  const second = await artifacts.getContent(revised.id);
  const artifact = await artifacts.get(created.id);
  if (!(second && artifact)) {
    throw new Error("Expected the second version");
  }
  const module = defineModule({
    artifact,
    id: moduleIdSchema.parse("notes"),
  });
  await modules.registerModule({ module });
  const version = defineModuleVersion({
    artifact,
    content: first,
    manifest: VALID_MANIFEST,
    module,
  });
  const alternateVersion = defineModuleVersion({
    artifact,
    content: second,
    manifest: VALID_MANIFEST,
    module,
  });
  return { alternateVersion, artifacts, module, modules, version };
}

async function jsonHarness(options: ArtifactModuleStoreOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "module-artifact-store-"));
  const path = join(directory, "artifacts.json");
  const seeded = await seed(new JsonArtifactStore({ path }), options);
  /** A new store, manager and adapter over the same file: only what was written survives. */
  const reopen = () =>
    Promise.resolve(
      createArtifactModuleStore(
        new ArtifactManager({ store: new JsonArtifactStore({ path }) })
      )
    );
  return {
    ...seeded,
    dispose: () => rm(directory, { force: true, recursive: true }),
    reopen,
  };
}

describeModuleStoreConformance("Artifact-backed JSON", async () => {
  const { alternateVersion, dispose, modules, reopen, version } =
    await jsonHarness();
  return {
    alternateVersion,
    containerId: "container-1",
    dispose,
    installation: {
      id: installationIdSchema.parse("installation-1"),
      now: NOW,
      version,
    },
    reopen,
    store: modules,
  };
});

describe("Artifact-backed ModuleStore", () => {
  it("keeps Installations and Grants in Module Artifact metadata, never in Content", async () => {
    const { artifacts, dispose, modules, version } = await jsonHarness();
    try {
      const before = await artifacts.getContent(version.contentId);
      const head = await artifacts.get(version.artifactId);
      const installation = await modules.createInstallation({
        id: installationIdSchema.parse("installation-1"),
        now: NOW,
        version,
      });
      const starting = await modules.beginInstallationTransition({
        expectedGeneration: 0,
        installationId: installation.id,
        now: NOW,
        status: "starting",
      });
      await modules.settleInstallationStatus({
        expectedGeneration: starting.generation,
        installationId: installation.id,
        now: NOW,
        status: "active",
      });
      await modules.replaceInstallationGrants({
        expectedGeneration: starting.generation,
        grants: [FETCH],
        installationId: installation.id,
        now: NOW,
      });
      const after = await artifacts.getContent(version.contentId);
      const artifact = await artifacts.get(version.artifactId);
      expect(after?.updatedAt).toEqual(before?.updatedAt);
      expect(after?.digest).toBe(before?.digest);
      expect(artifact?.contentId).toBe(head?.contentId);
      expect(artifact?.content?.updatedAt).toEqual(head?.content?.updatedAt);
      expect(artifact?.metadata.installations).toMatchObject({
        "installation-1": {
          grants: [{ capability: FETCH.capability }],
          installation: { generation: 1, status: "active" },
        },
      });
    } finally {
      await dispose();
    }
  });

  it("refuses invalid Module records as corruption instead of reading them", async () => {
    const skipped: ModuleStoreCorruptionError[] = [];
    const { artifacts, dispose, modules, version } = await jsonHarness({
      skipped: (error) => skipped.push(error),
    });
    try {
      await artifacts.patchArtifactMetadata(version.artifactId, {
        installations: {
          "installation-1": { grants: [], installation: { generation: -1 } },
        },
      });
      await expect(
        modules.loadGatewayContext(installationIdSchema.parse("installation-1"))
      ).rejects.toBeInstanceOf(ModuleStoreCorruptionError);
      await expect(
        modules.listInstallations({ moduleId: version.moduleId })
      ).rejects.toBeInstanceOf(ModuleStoreCorruptionError);
      // A scan across Modules leaves it out and says so.
      expect((await modules.listInstallations()).items).toEqual([]);
      expect(skipped).toHaveLength(1);
      expect(skipped[0]?.message).toContain(`Module ${version.moduleId}`);
    } finally {
      await dispose();
    }
  });

  it("keeps every other Module usable when one Module's records are corrupt", async () => {
    const skipped: ModuleStoreCorruptionError[] = [];
    const { artifacts, dispose, modules, version } = await jsonHarness({
      skipped: (error) => skipped.push(error),
    });
    try {
      const installation = await modules.createInstallation({
        id: installationIdSchema.parse("installation-1"),
        now: NOW,
        version,
      });
      const other = await artifacts.create({
        entries: PROGRAM_FILES,
        name: "Tasks",
        type: MODULE_MIME,
      });
      const tasks = defineModule({
        artifact: other,
        id: moduleIdSchema.parse("tasks"),
      });
      await modules.registerModule({ module: tasks });
      await artifacts.patchArtifactMetadata(other.id, {
        installations: { broken: { grants: "nope" } },
      });

      expect((await modules.listModules()).items.map(({ id }) => id)).toEqual([
        version.moduleId,
        tasks.id,
      ]);
      expect(await modules.loadModule(tasks.id)).toEqual(tasks);
      expect(
        (await modules.loadGatewayContext(installation.id))?.installation
      ).toEqual(installation);
      await expect(
        modules.beginInstallationTransition({
          expectedGeneration: 0,
          installationId: installation.id,
          now: NOW,
          status: "starting",
        })
      ).resolves.toMatchObject({ generation: 1 });
      expect(
        (await modules.listInstallations()).items.map(({ id }) => id)
      ).toEqual([installation.id]);
      await modules.listInstallations();
      // Reported once, however many scans skip it.
      expect(skipped.map((error) => error.message)).toEqual([
        expect.stringContaining("Module tasks"),
      ]);
      await expect(
        modules.listInstallations({ moduleId: tasks.id })
      ).rejects.toBeInstanceOf(ModuleStoreCorruptionError);
      await expect(
        modules.loadGatewayContext(installationIdSchema.parse("broken"))
      ).rejects.toBeInstanceOf(ModuleStoreCorruptionError);
    } finally {
      await dispose();
    }
  });

  it("reads records a newer Works wrote with fields it does not know", async () => {
    const { artifacts, dispose, modules, version } = await jsonHarness();
    try {
      const installation = await modules.createInstallation({
        id: installationIdSchema.parse("installation-1"),
        now: NOW,
        version,
      });
      await modules.replaceInstallationGrants({
        expectedGeneration: 0,
        grants: [FETCH],
        installationId: installation.id,
        now: NOW,
      });
      const installations = (await artifacts.get(version.artifactId))?.metadata
        .installations as
        | Record<string, { grants: object[]; installation: object }>
        | undefined;
      const stored = installations?.[installation.id];
      await artifacts.patchArtifactMetadata(version.artifactId, {
        installations: {
          [installation.id]: {
            future: true,
            grants: stored?.grants.map((grant) => ({ ...grant, scope: "x" })),
            installation: { ...stored?.installation, pinned: true },
          },
        },
      });
      expect(await modules.loadGatewayContext(installation.id)).toEqual({
        grants: [{ ...FETCH, createdAt: NOW }],
        installation,
      });
    } finally {
      await dispose();
    }
  });

  it("refuses a Module id claimed by two Artifacts, reports it, and keeps the others usable", async () => {
    const skipped: ModuleStoreCorruptionError[] = [];
    const { artifacts, dispose, modules, version } = await jsonHarness({
      skipped: (error) => skipped.push(error),
    });
    try {
      const tasks = await artifacts.create({
        entries: PROGRAM_FILES,
        name: "Tasks",
        type: MODULE_MIME,
      });
      await modules.registerModule({
        module: defineModule({
          artifact: tasks,
          id: moduleIdSchema.parse("tasks"),
        }),
      });
      const copy = await artifacts.create({
        entries: PROGRAM_FILES,
        name: "Notes copy",
        type: MODULE_MIME,
      });
      await artifacts.patchArtifactMetadata(copy.id, {
        moduleId: version.moduleId,
      });

      // Neither Artifact gets the identity, whichever lists first.
      expect((await modules.listModules()).items.map(({ id }) => id)).toEqual([
        "tasks",
      ]);
      expect(
        (await modules.moduleArtifacts()).map(({ id }) => id as string)
      ).toEqual([tasks.id]);
      await expect(modules.loadModule(version.moduleId)).rejects.toThrow(
        `Module ${version.moduleId} is registered on more than one Artifact`
      );
      await expect(
        modules.createInstallation({
          id: installationIdSchema.parse("installation-1"),
          now: NOW,
          version,
        })
      ).rejects.toBeInstanceOf(ModuleStoreCorruptionError);
      expect(await modules.loadModule(moduleIdSchema.parse("tasks"))).toEqual({
        artifactId: tasks.id,
        id: "tasks",
      });
      // Reported once, however many scans meet it.
      expect(skipped.map((error) => error.message)).toEqual([
        `Module ${version.moduleId} is registered on more than one Artifact`,
      ]);
    } finally {
      await dispose();
    }
  });

  it("keeps the fields a newer Works wrote when it writes the record", async () => {
    const { artifacts, dispose, modules, version } = await jsonHarness();
    const OTHER = { ...FETCH, capability: "host.files.read" } as const;
    try {
      const installation = await modules.createInstallation({
        id: installationIdSchema.parse("installation-1"),
        now: NOW,
        version,
      });
      await modules.replaceInstallationGrants({
        expectedGeneration: 0,
        grants: [FETCH, OTHER],
        installationId: installation.id,
        now: NOW,
      });
      const stored = async () => {
        const artifact = await artifacts.get(version.artifactId);
        const installations = artifact?.metadata.installations as
          | Record<
              string,
              { grants: Record<string, unknown>[]; installation: object }
            >
          | undefined;
        return installations?.[installation.id];
      };
      const written = await stored();
      // A newer Works narrowed the fetch Grant, pinned the Installation and
      // tagged the entry.
      await artifacts.patchArtifactMetadata(version.artifactId, {
        installations: {
          [installation.id]: {
            future: true,
            grants: written?.grants.map((grant) =>
              grant.capability === FETCH.capability
                ? { ...grant, expiresAt: "2026-09-01T00:00:00.000Z" }
                : grant
            ),
            installation: { ...written?.installation, pinned: true },
          },
        },
      });
      const starting = await modules.beginInstallationTransition({
        expectedGeneration: 0,
        installationId: installation.id,
        now: NOW,
        status: "starting",
      });
      await modules.revokeInstallationGrant({
        capability: OTHER.capability,
        expectedGeneration: starting.generation,
        installationId: installation.id,
      });
      expect(await stored()).toEqual({
        future: true,
        grants: [
          {
            ...FETCH,
            createdAt: NOW.toISOString(),
            expiresAt: "2026-09-01T00:00:00.000Z",
          },
        ],
        installation: expect.objectContaining({
          generation: starting.generation,
          pinned: true,
          status: "starting",
        }),
      });
    } finally {
      await dispose();
    }
  });

  it("refuses an Installation filed under another Module or id", async () => {
    const { artifacts, dispose, modules, version } = await jsonHarness();
    try {
      await modules.createInstallation({
        id: installationIdSchema.parse("installation-1"),
        now: NOW,
        version,
      });
      const artifact = await artifacts.get(version.artifactId);
      const installations = artifact?.metadata.installations as Record<
        string,
        unknown
      >;
      await artifacts.patchArtifactMetadata(version.artifactId, {
        installations: { moved: installations["installation-1"] },
      });
      await expect(
        modules.listInstallations({ moduleId: version.moduleId })
      ).rejects.toBeInstanceOf(ModuleStoreCorruptionError);
    } finally {
      await dispose();
    }
  });

  it("leaves the records as they were when a write fails to commit", async () => {
    const commits: { fail: boolean } = { fail: false };
    const store = new InMemoryArtifactStore({
      commit: () =>
        commits.fail
          ? Promise.reject(new Error("injected commit failure"))
          : Promise.resolve(),
    });
    const { modules, version } = await seed(store);
    const installation = await modules.createInstallation({
      id: installationIdSchema.parse("installation-1"),
      now: NOW,
      version,
    });
    await modules.replaceInstallationGrants({
      expectedGeneration: 0,
      grants: [FETCH],
      installationId: installation.id,
      now: NOW,
    });
    commits.fail = true;
    await expect(
      modules.beginInstallationTransition({
        expectedGeneration: 0,
        installationId: installation.id,
        now: NOW,
        status: "starting",
      })
    ).rejects.toThrow("injected commit failure");
    await expect(
      modules.revokeInstallationGrant({
        capability: FETCH.capability,
        expectedGeneration: 0,
        installationId: installation.id,
      })
    ).rejects.toThrow("injected commit failure");
    commits.fail = false;
    expect(await modules.loadGatewayContext(installation.id)).toEqual({
      grants: [{ ...FETCH, createdAt: NOW }],
      installation,
    });
    await expect(
      modules.beginInstallationTransition({
        expectedGeneration: 0,
        installationId: installation.id,
        now: NOW,
        status: "starting",
      })
    ).resolves.toMatchObject({ generation: 1, status: "starting" });
  });

  it("orders a Grant-checked save and a revoke by which transaction commits first", async () => {
    const { artifacts, dispose, modules, version } = await jsonHarness();
    try {
      const installation = await modules.createInstallation({
        id: installationIdSchema.parse("installation-1"),
        now: NOW,
        version,
      });
      const grant = () =>
        modules.replaceInstallationGrants({
          expectedGeneration: 0,
          grants: [FETCH],
          installationId: installation.id,
          now: NOW,
        });
      const revoke = () =>
        modules.revokeInstallationGrant({
          capability: FETCH.capability,
          expectedGeneration: 0,
          installationId: installation.id,
        });
      const file = await artifacts.create({
        entries: { "notes.md": { bytes: "first" } },
        name: "Notes",
        type: "text/markdown",
      });
      /**
       * An authorized save: it reads the Grant through the store inside the
       * same Artifact transaction that writes the file.
       */
      const save = (body: string, paused?: Promise<void>) =>
        artifacts.transaction(async (scoped) => {
          const context = await modules.loadGatewayContext(installation.id);
          await paused;
          if (
            !context?.grants.some(
              (candidate) => candidate.capability === FETCH.capability
            )
          ) {
            throw new Error("Not granted");
          }
          await scoped.write({
            artifactId: file.id,
            changes: { put: { "notes.md": { bytes: body } } },
          });
        });
      const text = async () => {
        const current = await artifacts.get(file.id);
        const read = current?.content
          ? await artifacts.readFile(current.content.id, "notes.md")
          : null;
        return read ? new TextDecoder().decode(read.blob) : null;
      };

      // A save that admitted its effect first commits; the revoke waits.
      await grant();
      const hold = Promise.withResolvers<void>();
      const admitted = save("saved before revoke", hold.promise);
      const revoking = revoke();
      hold.resolve();
      await admitted;
      await revoking;
      expect(await text()).toBe("saved before revoke");
      expect(
        (await modules.loadGatewayContext(installation.id))?.grants
      ).toEqual([]);

      // A revoke that commits first prevents the save that waited on it.
      await grant();
      const revoked = Promise.withResolvers<void>();
      const revokeFirst = modules.transaction(async () => {
        await revoke();
        await revoked.promise;
      });
      const late = save("must not land");
      revoked.resolve();
      await revokeFirst;
      await expect(late).rejects.toThrow("Not granted");
      expect(await text()).toBe("saved before revoke");
    } finally {
      await dispose();
    }
  });
});
