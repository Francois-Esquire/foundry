import { describe, expect, it } from "vitest";

import {
  createDisabledInstallation,
  defineModule,
  defineModuleVersion,
  installationIdSchema,
  moduleIdSchema,
} from "../domain";
import { ModuleStoreConflictError } from "../store/contract";
import { InMemoryModuleStore } from "../store/memory";
import { describeModuleStoreConformance } from "../testing/module-store-conformance";
import { moduleFixture, VALID_MANIFEST } from "./helpers/module-fixture";

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
  const store = new InMemoryModuleStore();
  await store.registerModule({ module });
  return { alternateVersion, installation, module, store, version };
}

describeModuleStoreConformance("InMemory", async () => {
  const { installation, version, alternateVersion, store } = await fixture();
  return {
    alternateVersion,
    containerId: "container-1",
    installation: {
      id: installation.id,
      now: installation.createdAt,
      version,
    },
    reopen: () => Promise.resolve(store),
    store,
  };
});

describe("InMemoryModuleStore", () => {
  it("registers a Module identity before it has a version", async () => {
    const { artifact, content } = await moduleFixture();
    const module = defineModule({
      artifact,
      id: moduleIdSchema.parse("module-draft"),
    });
    const store = new InMemoryModuleStore();

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
      store.transaction(async () => {
        await store.beginInstallationTransition({
          expectedGeneration: 0,
          installationId: installation.id,
          now: new Date("2026-08-08T00:01:00.000Z"),
          status: "starting",
        });
        await store.replaceInstallationGrants({
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
