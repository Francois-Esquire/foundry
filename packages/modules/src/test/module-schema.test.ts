import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineModule,
  defineModuleVersion,
  installationIdSchema,
  moduleIdSchema,
} from "../domain";
import { parseModuleManifest } from "../manifest";
import {
  installationGrantSchema,
  installationSchema,
  moduleSchema,
  retainedManifestSchema,
  storedInstallationSchema,
  storedManifestSchema,
} from "../schema";
import { InMemoryModuleStore } from "../store/memory";
import { moduleFixture, VALID_MANIFEST } from "./helpers/module-fixture";

/** A record schema that also refuses any field it does not declare. */
function exactly<Shape extends z.ZodRawShape>(
  schema: z.ZodReadonly<z.ZodObject<Shape>>
) {
  return z.strictObject(schema.unwrap().shape);
}

async function storedRecords() {
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
  const store = new InMemoryModuleStore();
  await store.registerModule({ module });
  await store.retainManifest({
    contentId: content.id,
    manifest: parseModuleManifest(VALID_MANIFEST),
    module,
  });
  const created = await store.createInstallation({
    id: installationIdSchema.parse("installation-1"),
    now: new Date("2026-08-08T00:00:00.000Z"),
    version,
  });
  await store.replaceInstallationGrants({
    expectedGeneration: created.generation,
    grants: [
      {
        capability: "host.files.read",
        constraintsDigest: "digest-files",
        version: 1,
      },
    ],
    installationId: created.id,
    now: new Date("2026-08-08T00:01:00.000Z"),
  });
  const started = await store.beginInstallationTransition({
    expectedGeneration: created.generation,
    installationId: created.id,
    now: new Date("2026-08-08T00:02:00.000Z"),
    status: "starting",
  });
  await store.setInstallationContainerId({
    containerId: "container-1",
    expectedGeneration: started.generation,
    installationId: created.id,
    now: new Date("2026-08-08T00:03:00.000Z"),
  });
  const context = await store.loadGatewayContext(created.id);
  return {
    context,
    module,
    modules: await store.listModules(),
    retained: await store.listRetainedManifests(),
    store,
  };
}

describe("Module record schemas", () => {
  it("describe every field of the records a ModuleStore returns", async () => {
    const { context, modules, retained } = await storedRecords();

    expect(modules.items).toHaveLength(1);
    for (const module of modules.items) {
      expect(exactly(moduleSchema).parse(module)).toEqual(module);
    }
    expect(retained).toHaveLength(1);
    for (const record of retained) {
      expect(exactly(retainedManifestSchema).parse(record)).toEqual(record);
    }
    expect(context?.installation.containerId).toBe("container-1");
    expect(exactly(installationSchema).parse(context?.installation)).toEqual(
      context?.installation
    );
    expect(context?.grants).toHaveLength(1);
    for (const grant of context?.grants ?? []) {
      expect(exactly(installationGrantSchema).parse(grant)).toEqual(grant);
    }
    expect(exactly(storedInstallationSchema).parse(context)).toEqual(context);
  });

  it("keep the owning Module with a retained manifest", async () => {
    const { module, retained } = await storedRecords();
    const [record] = retained;
    const stored = { ...record, moduleId: module.id };

    expect(exactly(storedManifestSchema).parse(stored)).toEqual(stored);
    expect(storedManifestSchema.safeParse(record).success).toBe(false);
  });

  it("refuse an Installation holding two Grants for one capability, as the Store does", async () => {
    const { context, store } = await storedRecords();
    if (context === null) {
      throw new Error("expected a gateway context");
    }
    const { installation } = context;
    const read = {
      capability: "host.files.read",
      constraintsDigest: "digest-files",
      version: 1,
    };
    const grants = [read, { ...read, version: 2 }];
    const message = "Grant capability host.files.read is duplicated";

    const result = storedInstallationSchema.safeParse({
      grants: grants.map((grant) => ({ ...grant, createdAt: new Date() })),
      installation,
    });

    expect(result.error?.issues).toEqual([
      expect.objectContaining({ message, path: ["grants"] }),
    ]);
    await expect(
      store.replaceInstallationGrants({
        expectedGeneration: installation.generation,
        grants,
        installationId: installation.id,
        now: new Date("2026-08-08T00:04:00.000Z"),
      })
    ).rejects.toThrow(message);
  });

  it("refuse values outside the persisted shape", () => {
    const installation = {
      containerId: "",
      contentId: "content-1",
      createdAt: new Date(),
      generation: -1,
      id: "installation-1",
      moduleId: "module-1",
      startAttempts: 0.5,
      status: "running",
      updatedAt: "2026-08-08T00:00:00.000Z",
    };

    const result = installationSchema.safeParse(installation);

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual(
      expect.arrayContaining([
        "containerId",
        "generation",
        "startAttempts",
        "status",
        "updatedAt",
      ])
    );
  });
});
