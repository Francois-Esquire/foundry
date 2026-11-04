import {
  ArtifactManager,
  type ArtifactStore,
  type BlobFiles,
} from "@foundry/artifacts";
import {
  type ArtifactModuleStore,
  createArtifactModuleStore,
} from "@foundry/modules/store/artifact";

export interface ModulePersistence {
  /** The one manager: library saves, releases, Installations and Grants share its transactions. */
  readonly artifacts: ArtifactManager;
  /** The durable ModuleStore, kept in Module Artifact metadata. */
  readonly modules: ArtifactModuleStore;
}

export interface ModulePersistenceOptions {
  /** Backing files for new payload bytes; records keep only references. */
  readonly files?: BlobFiles;
  /** A rejection limit per file, never a choice of where bytes are kept. */
  readonly maxFileBytes?: number;
}

const persistence = new WeakMap<ArtifactStore, ModulePersistence>();

/**
 * The Module library's manager and ModuleStore over `store`. Every caller
 * of one records store gets the same pair, so the library, the released
 * runtime and the Access panel never write through separate managers. The
 * first caller composes it; `options` are refused once it exists.
 */
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
        // A Module with corrupt records is left out of lists, never hidden:
        // opening it still fails with the same error.
        skipped: (error) =>
          process.stderr.write(`Module records skipped: ${error.message}\n`),
      }),
    });
    persistence.set(store, found);
  }
  return found;
}
