import { AsyncLocalStorage } from "node:async_hooks";
import {
  type ArtifactCursor,
  ArtifactManager,
  type ArtifactOperations,
  type ArtifactResolved,
  type ArtifactStore,
} from "@foundry/artifacts";
import { MODULE_MIME } from "@foundry/modules/constants";
import { type Module, moduleIdSchema } from "@foundry/modules/domain";
import {
  type ModuleStore,
  ModuleStoreConflictError,
} from "@foundry/modules/store/contract";

/** Module registration shares the Artifact transaction, including rollback. */
class ModuleArtifacts extends ArtifactManager {
  readonly scope = new AsyncLocalStorage<ArtifactOperations>();

  override transaction<T>(
    operation: (artifacts: ArtifactOperations) => Promise<T>
  ): Promise<T> {
    return super.transaction((scoped) =>
      this.scope.run(scoped, () => operation(scoped))
    );
  }

  get current(): ArtifactOperations {
    return this.scope.getStore() ?? this;
  }
}

export function createModulePersistence(store: ArtifactStore) {
  const artifacts = new ModuleArtifacts({ store });
  async function registered() {
    const records: ArtifactResolved[] = [];
    let cursor: ArtifactCursor | undefined;
    do {
      const page = await artifacts.current.list({
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
  const modules: Pick<
    ModuleStore,
    "loadModule" | "registerModule" | "retainManifest" | "transaction"
  > = {
    loadModule,
    async registerModule({ module }) {
      const existing = await loadModule(module.id);
      const artifact = await artifacts.current.get(module.artifactId);
      if (
        !artifact ||
        artifact.type !== MODULE_MIME ||
        (existing && existing.artifactId !== module.artifactId) ||
        (artifact.metadata.moduleId && artifact.metadata.moduleId !== module.id)
      ) {
        throw new ModuleStoreConflictError(
          "Module identity conflicts with its Artifact"
        );
      }
      await artifacts.current.patchArtifactMetadata(module.artifactId, {
        moduleId: module.id,
      });
      return module;
    },
    async retainManifest({ module, contentId, manifest }) {
      await modules.registerModule({ module });
      const artifact = await artifacts.current.get(module.artifactId);
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
      await artifacts.current.patchArtifactMetadata(module.artifactId, {
        retainedManifests: { ...retained, [contentId]: manifest },
      });
    },
    async transaction(operation) {
      if (!artifacts.scope.getStore()) {
        return artifacts.transaction(() => operation());
      }
      return operation();
    },
  };
  return { artifacts, modules, registered };
}
