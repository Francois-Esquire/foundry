import { contentIdSchema } from "@foundry/artifacts";
import { installationIdSchema, moduleIdSchema } from "@foundry/modules/domain";
import { parseModuleManifest } from "@foundry/modules/manifest";
import { describe, expect, it } from "vitest";
import {
  capabilityProviders,
  describedCapabilities,
  worksCapabilityCatalog,
} from "~/main/modules/capabilities";
import { ModuleRuntimeError } from "~/main/modules/runtime/controller";
import {
  preflightRelease,
  programResources,
} from "~/main/modules/runtime/preflight";
import { PROGRAM_MEMORY_BYTES } from "~/main/modules/settings";

const GIB = 1024 * 1024 * 1024;
const base = {
  capabilities: [],
  compatibility: { gateway: "1", runtime: "bun@1" },
  program: { entry: "outputs/packages/server/dist/index.js" },
  views: { home: { path: "/" } },
};
const legacy = {
  manifest: parseModuleManifest({ ...base, format: "foundry.module/1" }),
};
function strict(change: object) {
  return {
    manifest: parseModuleManifest({
      ...base,
      format: "foundry.module-manifest/1",
      ...change,
    }),
  };
}
const principal = {
  contentId: contentIdSchema.parse("content-1"),
  generation: 1,
  installationId: installationIdSchema.parse("installation-1"),
  moduleId: moduleIdSchema.parse("module-1"),
};

describe("Released Program preflight", () => {
  it("starts a Program that declares nothing exactly as before", () => {
    expect(programResources(legacy, {})).toEqual({
      cpus: 1,
      memoryBytes: PROGRAM_MEMORY_BYTES,
    });
  });

  it("meets the Manifest's resource requests and the user's values", () => {
    expect(
      programResources(strict({ resources: { cpus: 2, memoryBytes: GIB } }), {})
    ).toEqual({ cpus: 2, memoryBytes: GIB });
    expect(
      programResources(strict({}), { "resources.memoryBytes": GIB })
    ).toEqual({ cpus: 1, memoryBytes: GIB });
  });

  it.each([
    [
      "a hard storage limit",
      strict({ resources: { storageBytes: GIB } }),
      "cannot enforce",
    ],
    [
      "memory above the ceiling",
      strict({ resources: { memoryBytes: 3 * GIB } }),
      "this host allows at most",
    ],
    [
      "more CPUs than the ceiling",
      strict({ resources: { cpus: 8 } }),
      "resources.cpus",
    ],
  ])("refuses %s before acquiring anything", (_name, version, message) => {
    expect(() => programResources(version, {})).toThrow(ModuleRuntimeError);
    expect(() => programResources(version, {})).toThrow(message);
  });

  it("checks Capabilities against Works' own providers: required blocks, optional does not", async () => {
    const providers = capabilityProviders(describedCapabilities());
    // Works provides the theme, the Artifact operations and the execution
    // operations; deleting Artifacts is not among them.
    expect(
      worksCapabilityCatalog().capabilities.map(
        (capability) => capability.capability
      )
    ).toEqual([
      "works.system.theme",
      "works.editors.binding",
      "works.artifacts.read",
      "works.artifacts.save",
      "works.artifacts.create",
      "works.artifacts.watch",
      "works.artifacts.list",
      "works.execution.start",
      "works.execution.watch",
      "works.execution.cancel",
    ]);
    const request = {
      alias: "remove",
      capability: "works.artifacts.delete",
      reason: "Deletes files",
      version: 1,
    };
    await expect(
      preflightRelease({
        grants: [],
        principal,
        providers,
        user: {},
        version: strict({ capabilities: [{ ...request, required: false }] }),
      })
    ).resolves.toMatchObject({
      compatible: true,
      facts: [{ blocking: false, kind: "unknown-capability" }],
    });
    await expect(
      preflightRelease({
        grants: [],
        principal,
        providers,
        user: {},
        version: strict({ capabilities: [{ ...request, required: true }] }),
      })
    ).rejects.toThrow(
      "This release cannot start: Host does not provide works.artifacts.delete@1"
    );
  });
});
