import type { ArtifactCursor, ArtifactResolved } from "@foundry/artifacts";
import { nodeArtifacts } from "@foundry/artifacts/node";
import type { ArtifactStore } from "@foundry/artifacts/store";
import {
  MODULE_MIME,
  type Module,
  ModuleStoreConflictError,
  type ModuleUnit,
  moduleIdSchema,
  parseModuleManifest,
} from "@foundry/modules";

export function createModulePersistence(store: ArtifactStore) {
  const artifacts = nodeArtifacts({ store });
  async function registered() {
    const records: ArtifactResolved[] = [];
    let cursor: ArtifactCursor | undefined;
    do {
      const page = await artifacts.list({
        type: MODULE_MIME,
        ...(cursor ? { cursor } : {}),
      });
      records.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    const identities = new Set<string>();
    return records.filter((artifact) => {
      if (artifact.metadata.moduleId === undefined) {
        return false;
      }
      const id = moduleIdSchema.parse(artifact.metadata.moduleId);
      if (identities.has(id)) {
        throw new Error("Duplicate Module identity in Artifact records");
      }
      identities.add(id);
      return true;
    });
  }
  async function loadModule(id: Module["id"]): Promise<Module | null> {
    const artifact = (await registered()).find(
      (record) => record.metadata.moduleId === id
    );
    return artifact ? { artifactId: artifact.id, id } : null;
  }
  const modules: ModuleUnit<
    "loadModule" | "loadRetainedManifest" | "registerModule" | "retainManifest"
  > = {
    loadModule,
    async loadRetainedManifest(contentId) {
      for (const artifact of await registered()) {
        const manifests = artifact.metadata.retainedManifests;
        if (typeof manifests === "object" && manifests !== null) {
          const value: unknown = Object.getOwnPropertyDescriptor(
            manifests,
            contentId
          )?.value;
          if (value !== undefined) {
            return parseModuleManifest(value);
          }
        }
      }
      return null;
    },
    registerModule: ({ module }) =>
      artifacts.transaction(async () => {
        const existing = await loadModule(module.id);
        const artifact = await artifacts.get(module.artifactId);
        if (
          !artifact ||
          artifact.type !== MODULE_MIME ||
          (existing && existing.artifactId !== module.artifactId) ||
          (artifact.metadata.moduleId &&
            artifact.metadata.moduleId !== module.id)
        ) {
          throw new ModuleStoreConflictError(
            "Module identity conflicts with its Artifact"
          );
        }
        await artifacts.patchArtifactMetadata(module.artifactId, {
          moduleId: module.id,
        });
        return module;
      }),
    retainManifest: ({ module, contentId, manifest }) =>
      artifacts.transaction(async () => {
        await modules.registerModule({ module });
        const artifact = await artifacts.get(module.artifactId);
        const retained = artifact?.metadata.retainedManifests ?? {};
        if (
          typeof retained !== "object" ||
          retained === null ||
          Array.isArray(retained)
        ) {
          throw new Error("Invalid retained Module manifests");
        }
        const previous = Object.getOwnPropertyDescriptor(
          retained,
          contentId
        )?.value;
        if (previous && JSON.stringify(previous) !== JSON.stringify(manifest)) {
          throw new ModuleStoreConflictError(
            "Module version already retains a different manifest"
          );
        }
        await artifacts.patchArtifactMetadata(module.artifactId, {
          retainedManifests: { ...retained, [contentId]: manifest },
        });
      }),
    transaction: (work) =>
      artifacts.transaction((_artifacts, effects) => work(modules, effects)),
  };
  return { artifacts, modules, registered };
}
