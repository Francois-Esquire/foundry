import { describe, expect, it } from "vitest";

import {
  createDisabledInstallation,
  defineModule,
  defineModuleVersion,
  installationIdSchema,
  moduleIdSchema,
} from "../domain";
import {
  ModuleManifestValidationError,
  parseModuleManifest,
} from "../manifest";
import { moduleFixture } from "./helpers/module-fixture";

const validManifest = {
  capabilities: [
    {
      alias: "weather",
      capability: "host.network.fetch",
      reason: "Loads the selected forecast",
      required: false,
      version: 1,
    },
  ],
  compatibility: { gateway: "1", runtime: "bun@1" },
  format: "foundry.module/1",
  program: { entry: "outputs/program/server.js" },
  views: { home: { path: "/" } },
} as const;

async function validArtifact() {
  const { artifact, content } = await moduleFixture({ tag: "1.2.3" });
  return {
    artifact,
    content,
    module: defineModule({
      artifact,
      id: moduleIdSchema.parse(`module-${artifact.id}`),
    }),
  };
}

describe("target Module domain", () => {
  it.each(["generating", "failed", "ready"] as const)(
    "rejects %s Content as a Module version",
    async (state) => {
      const fixture = await validArtifact();
      expect(() =>
        defineModuleVersion({
          ...fixture,
          content: { ...fixture.content, state },
          manifest: validManifest,
        })
      ).toThrow("a Module version must be frozen");
    }
  );
  it("binds one valid Manifest to one frozen Content and creates a disabled Installation", async () => {
    const { artifact, module, content } = await validArtifact();
    const version = defineModuleVersion({
      artifact,
      content,
      manifest: validManifest,
      module,
    });
    const installation = createDisabledInstallation({
      id: installationIdSchema.parse("installation-1"),
      now: new Date("2026-08-08T00:00:00.000Z"),
      version,
    });

    expect(version).toMatchObject({
      artifactId: artifact.id,
      contentId: content.id,
      digest: content.digest,
      moduleId: module.id,
      tag: "1.2.3",
    });
    expect(installation).toMatchObject({
      containerId: null,
      contentId: content.id,
      generation: 0,
      moduleId: module.id,
      startAttempts: 0,
      status: "disabled",
    });
  });

  it.each([
    ["app kind", { ...validManifest, kind: "app" }],
    ["agent kind", { ...validManifest, kind: "agent" }],
    [
      "QuickJS runtime",
      {
        ...validManifest,
        compatibility: { ...validManifest.compatibility, runtime: "quickjs@1" },
      },
    ],
    [
      "multiple Programs",
      {
        ...validManifest,
        programs: [validManifest.program, validManifest.program],
      },
    ],
    [
      "unnamespaced capability",
      {
        ...validManifest,
        capabilities: [
          { ...validManifest.capabilities[0], capability: "weather" },
        ],
      },
    ],
    [
      "escaped path",
      { ...validManifest, program: { entry: "outputs/../secret.js" } },
    ],
  ])("rejects %s", (_name, manifest) => {
    expect(() => parseModuleManifest(manifest)).toThrow(
      ModuleManifestValidationError
    );
  });

  it("rejects mismatched Artifact and Content identity, a foreign Module, and invalid SemVer", async () => {
    const { artifact, module, content } = await validArtifact();
    expect(() =>
      defineModuleVersion({
        artifact,
        content: { ...content, artifactId: "another" as typeof artifact.id },
        manifest: validManifest,
        module,
      })
    ).toThrow(ModuleManifestValidationError);

    const foreign = await validArtifact();
    expect(() =>
      defineModuleVersion({
        artifact,
        content,
        manifest: validManifest,
        module: foreign.module,
      })
    ).toThrow(ModuleManifestValidationError);

    expect(() =>
      defineModuleVersion({
        artifact,
        content: { ...content, tag: "not-semver" },
        manifest: validManifest,
        module,
      })
    ).toThrow(ModuleManifestValidationError);
    expect(() =>
      defineModuleVersion({
        artifact,
        content: { ...content, tag: null },
        manifest: validManifest,
        module,
      })
    ).toThrow(ModuleManifestValidationError);
  });

  it("rejects a Manifest path not present in the immutable Content", async () => {
    const { artifact, module, content } = await validArtifact();
    expect(() =>
      defineModuleVersion({
        artifact,
        content,
        manifest: {
          ...validManifest,
          program: { entry: "outputs/program/missing.js" },
        },
        module,
      })
    ).toThrow(ModuleManifestValidationError);
  });
});
