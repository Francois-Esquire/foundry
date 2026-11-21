import { ArtifactManager, type BlobFiles } from "@foundry/artifacts";
import type { ArtifactStore } from "@foundry/artifacts/store";
import {
  type ArtifactModuleStore,
  createArtifactModuleStore,
} from "./store/artifact";

export interface ModulePersistence {
  readonly artifacts: ArtifactManager;
  readonly modules: ArtifactModuleStore;
}

export interface ModulePersistenceOptions {
  readonly files?: BlobFiles;
  readonly maxFileBytes?: number;
}

const persistence = new WeakMap<ArtifactStore, ModulePersistence>();

export function modulePersistence(
  store: ArtifactStore,
  options?: ModulePersistenceOptions
): ModulePersistence {
  let found = persistence.get(store);
  if (found && options) {
    throw new Error("Module persistence is already composed for this store");
  }
  if (!found) {
    const artifacts = new ArtifactManager({ store, ...options });
    found = Object.freeze({
      artifacts,
      modules: createArtifactModuleStore(artifacts, {
        skipped: (error) =>
          process.stderr.write(`Module records skipped: ${error.message}\n`),
      }),
    });
    persistence.set(store, found);
  }
  return found;
}
