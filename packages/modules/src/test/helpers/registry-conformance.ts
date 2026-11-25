import { artifactIdSchema } from "@foundry/artifacts";
import { describe, expect, it } from "vitest";

import type { InstallationId, ModuleVersion } from "../../domain";
import { installationIdSchema, moduleIdSchema } from "../../domain";
import {
  ModuleStoreConflictError,
  ModuleStoreNotFoundError,
} from "../../errors";
import type { InstallationGrant, Modules } from "../../modules";

export interface ModulesHarness {
  readonly alternateVersion: ModuleVersion;
  readonly containerId: string;
  readonly dispose?: () => void | Promise<void>;
  readonly installation: {
    readonly id: InstallationId;
    readonly version: ModuleVersion;
    readonly now: Date;
  };
  readonly reopen: () => Promise<Modules>;
  readonly store: Modules;
}

const NESTED_REFUSAL =
  /ReentrantCallError: .*transactions do not nest; use the registry passed/;

function settled(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "resolved",
    (error: unknown) => `refused: ${String(error)}`
  );
}

const REFUSAL = /ReentrantCallError: .*use the/;

const T = (minute: number) =>
  new Date(`2026-08-09T00:${String(minute).padStart(2, "0")}:00.000Z`);

const FETCH = {
  capability: "host.network.fetch",
  constraintsDigest: "digest-fetch",
  version: 1,
} as const;
const FILES = {
  capability: "host.files.read",
  constraintsDigest: "digest-files",
  version: 2,
} as const;

export function describeModules(
  name: string,
  createHarness: () => Promise<ModulesHarness>
): void {
  describe(`${name} Modules rules`, () => {
    it("refuses a transaction on the registry a transaction handed its work, at once", async () => {
      const harness = await createHarness();
      try {
        const { version } = harness.installation;
        const module = { artifactId: version.artifactId, id: version.moduleId };
        let ran = false;
        const outcome = await harness.store.transaction(async (registry) => {
          const nested = await settled(
            registry.transaction(async (inner) => {
              ran = true;
              await inner.createInstallation(harness.installation);
              throw new Error("abort inner");
            })
          );
          await registry.registerModule({ module });
          return nested;
        });

        expect(outcome).toMatch(NESTED_REFUSAL);
        expect(ran).toBe(false);
        expect(
          await harness.store.loadGatewayContext(harness.installation.id)
        ).toBeNull();
      } finally {
        await harness.dispose?.();
      }
    });

    it("states its durability: a command's commit is durable, a transaction's registry's is not", async () => {
      const harness = await createHarness();
      try {
        expect(harness.store.durability).toBe("commit");
        expect(
          await harness.store.transaction((registry) =>
            Promise.resolve(registry.durability)
          )
        ).toBe("host");
      } finally {
        await harness.dispose?.();
      }
    });

    it("runs a transaction's effects once it commits, every one though one throws", async () => {
      const harness = await createHarness();
      try {
        const seen: string[] = [];
        const failure = new Error("effect failed");
        const outcome = harness.store.transaction(async (registry, effects) => {
          await registry.createInstallation(harness.installation);
          effects.afterCommit(async () => {
            const context = await harness.store.loadGatewayContext(
              harness.installation.id
            );
            seen.push(context === null ? "missing" : "committed");
            throw failure;
          });
          effects.afterCommit(() => {
            seen.push("second");
            return Promise.resolve();
          });
          expect(seen).toEqual([]);
          return "done";
        });

        await expect(outcome).rejects.toBe(failure);
        expect(seen).toEqual(["committed", "second"]);
      } finally {
        await harness.dispose?.();
      }
    });

    it("runs none of a transaction's effects when it rolls back, and refuses one registered late", async () => {
      const harness = await createHarness();
      try {
        const seen: string[] = [];
        const original = new Error("outer rollback");
        let late: { afterCommit: (effect: () => Promise<void>) => void } = {
          afterCommit: () => undefined,
        };
        await expect(
          harness.store.transaction(async (registry, effects) => {
            await registry.createInstallation(harness.installation);
            effects.afterCommit(() => {
              seen.push("ran");
              return Promise.resolve();
            });
            late = effects;
            throw original;
          })
        ).rejects.toBe(original);

        expect(seen).toEqual([]);
        expect(
          await harness.store.loadGatewayContext(harness.installation.id)
        ).toBeNull();
        expect(() => late.afterCommit(() => Promise.resolve())).toThrow(
          "has settled"
        );
      } finally {
        await harness.dispose?.();
      }
    });

    it("reads each value nested in a retained manifest once, and keeps what that read gave", async () => {
      const harness = await createHarness();
      try {
        const { version } = harness.installation;
        let reads = 0;
        const manifest = {
          ...structuredClone(version.manifest),
          get views() {
            reads += 1;
            return reads === 1
              ? structuredClone(version.manifest.views)
              : Object.create({ inherited: "lost" });
          },
        };
        await harness.store.retainManifest({
          contentId: version.contentId,
          manifest,
          module: { artifactId: version.artifactId, id: version.moduleId },
        });

        expect(reads).toBe(1);
        expect(
          await harness.store.loadRetainedManifest(version.contentId)
        ).toEqual(version.manifest);
      } finally {
        await harness.dispose?.();
      }
    });

    it("reads each input field by name, wherever it lives, in every command", async () => {
      const harness = await createHarness();
      try {
        const { id, now, version } = harness.installation;
        const inherited = <T extends object>(fields: T): T =>
          Object.create(fields) as T;
        const created = await harness.store.createInstallation(
          inherited({ id, now, version: inherited({ ...version }) })
        );
        expect(created).toMatchObject({ id, moduleId: version.moduleId });
        const grants = await harness.store.replaceInstallationGrants(
          inherited({
            expectedGeneration: 0,
            grants: [inherited({ ...FETCH })],
            installationId: id,
            now: T(5),
          })
        );
        expect(grants).toEqual([{ ...FETCH, createdAt: T(5) }]);
        await harness.store.revokeInstallationGrant(
          inherited({
            capability: FETCH.capability,
            expectedGeneration: 0,
            installationId: id,
          })
        );
        await harness.store.deleteInstallation(
          inherited({ expectedGeneration: 0, installationId: id })
        );
        await harness.store.deleteModule(
          inherited({ moduleId: version.moduleId })
        );
        expect(await harness.store.loadModule(version.moduleId)).toBeNull();
      } finally {
        await harness.dispose?.();
      }
    });

    it("refuses a call to the registry from inside its own transaction, at once", async () => {
      const harness = await createHarness();
      try {
        const outcome = await harness.store.transaction(async (registry) => {
          const refused = await Promise.race([
            harness.store.loadGatewayContext(harness.installation.id).then(
              () => "resolved",
              (error: unknown) => String(error)
            ),
            new Promise<string>((resolve) => {
              setTimeout(() => resolve("still pending"), 1000);
            }),
          ]);
          await registry.createInstallation(harness.installation);
          return refused;
        });
        expect(outcome).toMatch(REFUSAL);
        expect(
          await harness.store.loadGatewayContext(harness.installation.id)
        ).not.toBeNull();
      } finally {
        await harness.dispose?.();
      }
    });

    it("takes a command's input when it is called, though the command waits its turn", async () => {
      const harness = await createHarness();
      try {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const holding = harness.store.transaction(async () => {
          entered.resolve();
          await release.promise;
        });
        await entered.promise;
        const input = {
          id: harness.installation.id,
          now: new Date(harness.installation.now),
          version: { ...harness.installation.version },
        };
        const created = harness.store.createInstallation(input);
        input.now.setTime(0);
        Object.assign(input, { id: installationIdSchema.parse("changed") });
        Object.assign(input.version, {
          moduleId: moduleIdSchema.parse("changed"),
        });
        release.resolve();
        await holding;

        expect(await created).toMatchObject({
          createdAt: harness.installation.now,
          id: harness.installation.id,
          moduleId: harness.installation.version.moduleId,
        });
      } finally {
        await harness.dispose?.();
      }
    });

    it("takes nested input when a command is called: a manifest, a Grant set and its time", async () => {
      const harness = await createHarness();
      try {
        const { version } = harness.installation;
        await harness.store.createInstallation(harness.installation);
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const holding = harness.store.transaction(async () => {
          entered.resolve();
          await release.promise;
        });
        await entered.promise;

        const manifest = structuredClone(version.manifest) as {
          views: Record<string, unknown>;
        };
        const retaining = harness.store.retainManifest({
          contentId: version.contentId,
          manifest: manifest as unknown as typeof version.manifest,
          module: { artifactId: version.artifactId, id: version.moduleId },
        });
        const grants: Omit<InstallationGrant, "createdAt">[] = [{ ...FETCH }];
        const now = new Date(T(5));
        const replacing = harness.store.replaceInstallationGrants({
          expectedGeneration: 0,
          grants,
          installationId: harness.installation.id,
          now,
        });
        manifest.views = { changed: { path: "/changed" } };
        Object.assign(grants[0] as object, { capability: "changed" });
        grants.push({ ...FILES });
        now.setTime(0);
        release.resolve();
        await Promise.all([holding, retaining, replacing]);

        expect(
          await harness.store.loadRetainedManifest(version.contentId)
        ).toEqual(version.manifest);
        expect(
          (await harness.store.loadGatewayContext(harness.installation.id))
            ?.grants
        ).toEqual([{ ...FETCH, createdAt: T(5) }]);
      } finally {
        await harness.dispose?.();
      }
    });

    it("creates a disabled Installation of a version of a registered Module", async () => {
      const harness = await createHarness();
      try {
        const installation = await harness.store.createInstallation(
          harness.installation
        );
        expect(installation).toEqual({
          containerId: null,
          contentId: harness.installation.version.contentId,
          createdAt: harness.installation.now,
          generation: 0,
          id: harness.installation.id,
          moduleId: harness.installation.version.moduleId,
          startAttempts: 0,
          status: "disabled",
          updatedAt: harness.installation.now,
        });
        await expect(
          harness.store.createInstallation(harness.installation)
        ).rejects.toBeInstanceOf(ModuleStoreConflictError);
        await expect(
          harness.store.createInstallation({
            ...harness.installation,
            id: installationIdSchema.parse("foreign-artifact"),
            version: {
              ...harness.installation.version,
              artifactId: artifactIdSchema.parse("foreign-artifact"),
            },
          })
        ).rejects.toBeInstanceOf(ModuleStoreConflictError);
        await expect(
          harness.store.createInstallation({
            ...harness.installation,
            id: installationIdSchema.parse("unregistered-module"),
            version: {
              ...harness.installation.version,
              moduleId: moduleIdSchema.parse("unregistered-module"),
            },
          })
        ).rejects.toBeInstanceOf(ModuleStoreConflictError);

        const reopened = await harness.reopen();
        await expect(
          reopened.loadGatewayContext(installation.id)
        ).resolves.toEqual({ grants: [], installation });
        expect(
          await reopened.loadGatewayContext(
            installationIdSchema.parse("missing")
          )
        ).toBeNull();
      } finally {
        await harness.dispose?.();
      }
    });

    it("persists and clears the container link without changing the running generation", async () => {
      const harness = await createHarness();
      try {
        const created = await harness.store.createInstallation(
          harness.installation
        );
        const starting = await harness.store.beginInstallationTransition({
          expectedGeneration: 0,
          installationId: created.id,
          now: T(1),
          status: "starting",
        });
        const linked = await harness.store.setInstallationContainerId({
          containerId: harness.containerId,
          expectedGeneration: starting.generation,
          installationId: created.id,
          now: T(2),
        });
        expect(linked).toEqual({
          ...starting,
          containerId: harness.containerId,
          updatedAt: T(2),
        });
        const reopened = await harness.reopen();
        expect(await reopened.loadGatewayContext(created.id)).toEqual({
          grants: [],
          installation: linked,
        });
        expect((await reopened.listInstallations()).items).toEqual([linked]);
        await expect(
          reopened.setInstallationContainerId({
            containerId: null,
            expectedGeneration: 0,
            installationId: created.id,
            now: T(3),
          })
        ).rejects.toBeInstanceOf(ModuleStoreConflictError);
        expect(
          (await reopened.loadGatewayContext(created.id))?.installation
        ).toEqual(linked);
        await expect(
          reopened.setInstallationContainerId({
            containerId: harness.containerId,
            expectedGeneration: 0,
            installationId: installationIdSchema.parse("missing"),
            now: T(3),
          })
        ).rejects.toBeInstanceOf(ModuleStoreNotFoundError);
        const cleared = await reopened.setInstallationContainerId({
          containerId: null,
          expectedGeneration: starting.generation,
          installationId: created.id,
          now: T(4),
        });
        expect(cleared).toEqual({
          ...starting,
          containerId: null,
          updatedAt: T(4),
        });
        expect(
          (await reopened.loadGatewayContext(created.id))?.installation
        ).toEqual(cleared);
      } finally {
        await harness.dispose?.();
      }
    });

    it("bumps the generation on begin transitions and keeps it on settlement", async () => {
      const harness = await createHarness();
      try {
        const created = await harness.store.createInstallation(
          harness.installation
        );
        const starting = await harness.store.beginInstallationTransition({
          expectedGeneration: 0,
          installationId: created.id,
          now: T(1),
          status: "starting",
        });
        expect(starting).toMatchObject({
          createdAt: created.createdAt,
          generation: 1,
          status: "starting",
          updatedAt: T(1),
        });
        const active = await harness.store.settleInstallationStatus({
          expectedGeneration: 1,
          installationId: created.id,
          now: T(2),
          status: "active",
        });
        expect(active).toMatchObject({ generation: 1, status: "active" });
        const stopping = await harness.store.beginInstallationTransition({
          expectedGeneration: 1,
          installationId: created.id,
          now: T(3),
          status: "stopping",
        });
        expect(stopping).toMatchObject({ generation: 2, status: "stopping" });
        const disabled = await harness.store.settleInstallationStatus({
          expectedGeneration: 2,
          installationId: created.id,
          now: T(4),
          status: "disabled",
        });
        expect(disabled).toMatchObject({
          generation: 2,
          status: "disabled",
          updatedAt: T(4),
        });

        await expect(
          harness.store.beginInstallationTransition({
            expectedGeneration: 1,
            installationId: created.id,
            now: T(5),
            status: "starting",
          })
        ).rejects.toBeInstanceOf(ModuleStoreConflictError);
        await expect(
          harness.store.settleInstallationStatus({
            expectedGeneration: 1,
            installationId: created.id,
            now: T(5),
            status: "failed",
          })
        ).rejects.toBeInstanceOf(ModuleStoreConflictError);
        await expect(
          harness.store.beginInstallationTransition({
            expectedGeneration: 0,
            installationId: installationIdSchema.parse("missing"),
            now: T(5),
            status: "starting",
          })
        ).rejects.toBeInstanceOf(ModuleStoreNotFoundError);

        const reopened = await harness.reopen();
        await expect(
          reopened.loadGatewayContext(created.id)
        ).resolves.toMatchObject({
          installation: { generation: 2, status: "disabled" },
        });
      } finally {
        await harness.dispose?.();
      }
    });

    it("counts failed starts until an active settlement, a user enable, or a version change", async () => {
      const harness = await createHarness();
      try {
        const created = await harness.store.createInstallation(
          harness.installation
        );
        const fail = async (generation: number): Promise<number> => {
          await harness.store.beginInstallationTransition({
            expectedGeneration: generation,
            installationId: created.id,
            now: T(1),
            status: "starting",
          });
          const failed = await harness.store.settleInstallationStatus({
            expectedGeneration: generation + 1,
            installationId: created.id,
            now: T(2),
            status: "failed",
          });
          expect(failed.status).toBe("failed");
          return failed.startAttempts;
        };
        expect(await fail(0)).toBe(1);
        expect(await fail(1)).toBe(2);

        const reset = await harness.store.beginInstallationTransition({
          expectedGeneration: 2,
          installationId: created.id,
          now: T(3),
          resetStartAttempts: true,
          status: "starting",
        });
        expect(reset).toMatchObject({ generation: 3, startAttempts: 0 });
        const failedAgain = await harness.store.settleInstallationStatus({
          expectedGeneration: 3,
          installationId: created.id,
          now: T(4),
          status: "failed",
        });
        expect(failedAgain.startAttempts).toBe(1);

        await harness.store.beginInstallationTransition({
          expectedGeneration: 3,
          installationId: created.id,
          now: T(5),
          status: "starting",
        });
        const active = await harness.store.settleInstallationStatus({
          expectedGeneration: 4,
          installationId: created.id,
          now: T(6),
          status: "active",
        });
        expect(active.startAttempts).toBe(0);

        expect(await fail(4)).toBe(1);
        const selected = await harness.store.selectInstallationVersion({
          expectedGeneration: 5,
          installationId: created.id,
          now: T(7),
          version: harness.alternateVersion,
        });
        expect(selected).toMatchObject({
          contentId: harness.alternateVersion.contentId,
          generation: 6,
          startAttempts: 0,
          status: "failed",
        });
        await expect(
          harness.store.selectInstallationVersion({
            expectedGeneration: 5,
            installationId: created.id,
            now: T(8),
            version: harness.installation.version,
          })
        ).rejects.toBeInstanceOf(ModuleStoreConflictError);
        await expect(
          harness.store.selectInstallationVersion({
            expectedGeneration: 6,
            installationId: created.id,
            now: T(8),
            version: {
              ...harness.alternateVersion,
              artifactId: artifactIdSchema.parse("foreign-artifact"),
            },
          })
        ).rejects.toBeInstanceOf(ModuleStoreConflictError);
        await expect(
          harness.store.selectInstallationVersion({
            expectedGeneration: 6,
            installationId: created.id,
            now: T(8),
            version: {
              ...harness.alternateVersion,
              moduleId: moduleIdSchema.parse("unregistered-module"),
            },
          })
        ).rejects.toBeInstanceOf(ModuleStoreConflictError);

        const reopened = await harness.reopen();
        await expect(
          reopened.loadGatewayContext(created.id)
        ).resolves.toMatchObject({
          installation: {
            contentId: harness.alternateVersion.contentId,
            generation: 6,
            startAttempts: 0,
          },
        });
      } finally {
        await harness.dispose?.();
      }
    });

    it("replaces and revokes grants under the generation without bumping it", async () => {
      const harness = await createHarness();
      try {
        const created = await harness.store.createInstallation(
          harness.installation
        );
        await expect(
          harness.store.replaceInstallationGrants({
            expectedGeneration: 1,
            grants: [FETCH],
            installationId: created.id,
            now: T(1),
          })
        ).rejects.toBeInstanceOf(ModuleStoreConflictError);
        const granted = await harness.store.replaceInstallationGrants({
          expectedGeneration: 0,
          grants: [FILES, FETCH],
          installationId: created.id,
          now: T(1),
        });
        expect(granted).toEqual([
          { ...FILES, createdAt: T(1) },
          { ...FETCH, createdAt: T(1) },
        ]);
        await expect(
          harness.store.replaceInstallationGrants({
            expectedGeneration: 0,
            grants: [FETCH, { ...FETCH, constraintsDigest: "other" }],
            installationId: created.id,
            now: T(1),
          })
        ).rejects.toBeInstanceOf(ModuleStoreConflictError);

        const context = await harness.store.loadGatewayContext(created.id);
        expect(context?.installation.generation).toBe(0);
        expect(context?.grants).toEqual([
          { ...FILES, createdAt: T(1) },
          { ...FETCH, createdAt: T(1) },
        ]);

        const replaced = await harness.store.replaceInstallationGrants({
          expectedGeneration: 0,
          grants: [{ ...FETCH, constraintsDigest: "digest-fetch-2" }],
          installationId: created.id,
          now: T(2),
        });
        expect(replaced).toEqual([
          { ...FETCH, constraintsDigest: "digest-fetch-2", createdAt: T(2) },
        ]);

        await expect(
          harness.store.revokeInstallationGrant({
            capability: FILES.capability,
            expectedGeneration: 0,
            installationId: created.id,
          })
        ).rejects.toBeInstanceOf(ModuleStoreConflictError);
        await expect(
          harness.store.revokeInstallationGrant({
            capability: FETCH.capability,
            expectedGeneration: 1,
            installationId: created.id,
          })
        ).rejects.toBeInstanceOf(ModuleStoreConflictError);
        const revoked = await harness.store.revokeInstallationGrant({
          capability: FETCH.capability,
          expectedGeneration: 0,
          installationId: created.id,
        });
        expect(revoked).toEqual({
          ...FETCH,
          constraintsDigest: "digest-fetch-2",
          createdAt: T(2),
        });

        const reopened = await harness.reopen();
        await expect(
          reopened.loadGatewayContext(created.id)
        ).resolves.toMatchObject({
          grants: [],
          installation: { generation: 0 },
        });
      } finally {
        await harness.dispose?.();
      }
    });

    it("deletes an Installation with its grants under the generation", async () => {
      const harness = await createHarness();
      try {
        const created = await harness.store.createInstallation(
          harness.installation
        );
        await harness.store.replaceInstallationGrants({
          expectedGeneration: 0,
          grants: [FETCH],
          installationId: created.id,
          now: T(1),
        });
        await expect(
          harness.store.deleteInstallation({
            expectedGeneration: 1,
            installationId: created.id,
          })
        ).rejects.toBeInstanceOf(ModuleStoreConflictError);
        await harness.store.deleteInstallation({
          expectedGeneration: 0,
          installationId: created.id,
        });
        expect(await harness.store.loadGatewayContext(created.id)).toBeNull();
        await expect(
          harness.store.deleteInstallation({
            expectedGeneration: 0,
            installationId: created.id,
          })
        ).rejects.toBeInstanceOf(ModuleStoreNotFoundError);

        const reopened = await harness.reopen();
        expect(await reopened.loadGatewayContext(created.id)).toBeNull();
        expect((await reopened.listInstallations()).items).toEqual([]);
      } finally {
        await harness.dispose?.();
      }
    });

    it("rolls back a failed cohesive Store transaction", async () => {
      const harness = await createHarness();
      try {
        const installationId = installationIdSchema.parse(
          `${harness.installation.id}-rolled-back`
        );
        await expect(
          harness.store.transaction(async (registry) => {
            await registry.createInstallation({
              ...harness.installation,
              id: installationId,
            });
            throw new Error("injected transaction failure");
          })
        ).rejects.toThrow("injected transaction failure");
        expect(
          await harness.store.loadGatewayContext(installationId)
        ).toBeNull();
      } finally {
        await harness.dispose?.();
      }
    });

    it("serializes outside writes and preserves them after transaction rollback", async () => {
      const harness = await createHarness();
      try {
        const rolledBackId = installationIdSchema.parse(
          `${harness.installation.id}-rolled-back-concurrent`
        );
        const survivingId = installationIdSchema.parse(
          `${harness.installation.id}-surviving-concurrent`
        );
        let transactionStarted: (() => void) | undefined;
        let releaseTransaction: (() => void) | undefined;
        const started = new Promise<void>((resolve) => {
          transactionStarted = resolve;
        });
        const hold = new Promise<void>((resolve) => {
          releaseTransaction = resolve;
        });
        const transaction = harness.store.transaction(async (registry) => {
          await registry.createInstallation({
            ...harness.installation,
            id: rolledBackId,
          });
          transactionStarted?.();
          await hold;
          throw new Error("injected concurrent transaction failure");
        });
        await started;
        let outsideSettled = false;
        const outside = harness.store
          .createInstallation({
            ...harness.installation,
            id: survivingId,
          })
          .then(() => {
            outsideSettled = true;
          });
        await Promise.resolve();
        expect(outsideSettled).toBe(false);
        releaseTransaction?.();
        await expect(transaction).rejects.toThrow(
          "injected concurrent transaction failure"
        );
        await outside;
        expect(await harness.store.loadGatewayContext(rolledBackId)).toBeNull();
        expect(
          await harness.store.loadGatewayContext(survivingId)
        ).not.toBeNull();
      } finally {
        await harness.dispose?.();
      }
    });

    it("lists Modules and Installations through bounded deterministic pages", async () => {
      const harness = await createHarness();
      try {
        expect(await harness.store.listModules()).toMatchObject({
          items: [
            {
              artifactId: harness.installation.version.artifactId,
              id: harness.installation.version.moduleId,
            },
          ],
        });

        const first = await harness.store.createInstallation(
          harness.installation
        );
        const second = await harness.store.createInstallation({
          ...harness.installation,
          id: installationIdSchema.parse(`${first.id}-second`),
        });
        const installations = await harness.store.listInstallations({
          limit: 1,
        });
        expect(installations.items).toHaveLength(1);
        expect(installations.total).toBe(2);
        expect(installations.nextCursor).toBeDefined();
        await expect(
          harness.store.listInstallations({ cursor: "missing" })
        ).rejects.toBeInstanceOf(ModuleStoreConflictError);
        const remaining = await harness.store.listInstallations({
          cursor: installations.nextCursor,
          limit: 1,
        });
        expect(remaining.total).toBe(2);
        expect(remaining.nextCursor).toBeUndefined();
        expect(
          [...installations.items, ...remaining.items].map(({ id }) => id)
        ).toEqual([first.id, second.id].sort());
      } finally {
        await harness.dispose?.();
      }
    });

    it("filters listed Installations by Module across pages", async () => {
      const harness = await createHarness();
      try {
        const { moduleId } = harness.installation.version;
        const first = await harness.store.createInstallation(
          harness.installation
        );
        const second = await harness.store.createInstallation({
          ...harness.installation,
          id: installationIdSchema.parse(`${first.id}-second`),
        });
        const head = await harness.store.listInstallations({
          limit: 1,
          moduleId,
        });
        const tail = await harness.store.listInstallations({
          cursor: head.nextCursor,
          limit: 1,
          moduleId,
        });
        expect(head.total).toBe(2);
        expect(tail.nextCursor).toBeUndefined();
        expect([...head.items, ...tail.items].map(({ id }) => id)).toEqual(
          [first.id, second.id].sort()
        );
        expect(
          await harness.store.listInstallations({
            moduleId: moduleIdSchema.parse("unregistered-module"),
          })
        ).toMatchObject({ items: [], total: 0 });
      } finally {
        await harness.dispose?.();
      }
    });

    it("orders listed identities by code unit, not locale", async () => {
      const harness = await createHarness();
      try {
        for (const id of ["a", "B"]) {
          await harness.store.createInstallation({
            ...harness.installation,
            id: installationIdSchema.parse(id),
          });
        }
        expect(
          (await harness.store.listInstallations()).items.map(({ id }) => id)
        ).toEqual(["B", "a"]);
      } finally {
        await harness.dispose?.();
      }
    });

    it("retains a manifest idempotently, refuses a different one, and drops it on request", async () => {
      const harness = await createHarness();
      try {
        const { version } = harness.installation;
        const module = { artifactId: version.artifactId, id: version.moduleId };
        expect(
          await harness.store.loadRetainedManifest(version.contentId)
        ).toBeNull();
        expect(await harness.store.listRetainedManifests()).toEqual([]);

        const retained = {
          contentId: version.contentId,
          manifest: version.manifest,
          module,
        };
        await harness.store.retainManifest(retained);
        await harness.store.retainManifest(retained);
        await expect(
          harness.store.retainManifest({
            ...retained,
            manifest: {
              ...version.manifest,
              views: { main: { path: "/" } },
            },
          })
        ).rejects.toBeInstanceOf(ModuleStoreConflictError);
        await harness.store.retainManifest({
          ...retained,
          contentId: harness.alternateVersion.contentId,
        });

        const reopened = await harness.reopen();
        expect(await reopened.loadRetainedManifest(version.contentId)).toEqual(
          version.manifest
        );
        expect(await reopened.listRetainedManifests()).toEqual(
          [version.contentId, harness.alternateVersion.contentId]
            .sort()
            .map((contentId) => ({ contentId, manifest: version.manifest }))
        );

        await reopened.dropRetainedManifest(version.contentId);
        await reopened.dropRetainedManifest(version.contentId);
        expect(
          await reopened.loadRetainedManifest(version.contentId)
        ).toBeNull();
        expect(
          (await reopened.listRetainedManifests()).map(
            ({ contentId }) => contentId
          )
        ).toEqual([harness.alternateVersion.contentId]);
      } finally {
        await harness.dispose?.();
      }
    });

    it("retires a Module and its retained manifests only once nothing is installed", async () => {
      const harness = await createHarness();
      try {
        const { version } = harness.installation;
        await harness.store.retainManifest({
          contentId: version.contentId,
          manifest: version.manifest,
          module: { artifactId: version.artifactId, id: version.moduleId },
        });
        const installation = await harness.store.createInstallation(
          harness.installation
        );

        await expect(
          harness.store.deleteModule({ moduleId: version.moduleId })
        ).rejects.toBeInstanceOf(ModuleStoreConflictError);
        expect(await harness.store.loadModule(version.moduleId)).not.toBeNull();
        expect(
          await harness.store.loadRetainedManifest(version.contentId)
        ).not.toBeNull();

        await harness.store.deleteInstallation({
          expectedGeneration: installation.generation,
          installationId: installation.id,
        });
        await harness.store.deleteModule({ moduleId: version.moduleId });

        expect(await harness.store.loadModule(version.moduleId)).toBeNull();
        expect(
          await harness.store.loadRetainedManifest(version.contentId)
        ).toBeNull();
        const reopened = await harness.reopen();
        expect(await reopened.loadModule(version.moduleId)).toBeNull();
        await expect(
          reopened.deleteModule({ moduleId: version.moduleId })
        ).rejects.toBeInstanceOf(ModuleStoreConflictError);
      } finally {
        await harness.dispose?.();
      }
    });
  });
}
