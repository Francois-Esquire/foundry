import type { ArtifactStore } from "@foundry/artifacts";
import type { WorksExecution } from "~/main/execution/contract";
import {
  SourceEvidence,
  type SourceSaves,
} from "~/main/execution/source-evidence";
import { modulePersistence } from "~/main/modules/artifact-store";
import { createModuleRecords } from "~/main/modules/library";
import {
  type ModuleStoreOptions,
  openLocalModuleLibrary,
  openModuleStore,
} from "~/main/modules/local-library";

/**
 * Source saves for tests that are not about save evidence: each commits at
 * once with an origin that names no run, and nothing is recorded.
 */
export const unrecordedSaves: SourceSaves = {
  admit: () => Promise.resolve(),
  async run(save, commit) {
    const { value } = await commit({
      actor: save.actor,
      at: new Date().toISOString(),
      kind: save.kind,
      runId: "unrecorded",
    });
    return value;
  },
};

/** Source saves as Works records them, over `store`'s Module records. */
export function recordedSaves(
  execution: Pick<WorksExecution, "dispatch" | "runs">,
  store: ArtifactStore
): SourceEvidence {
  return new SourceEvidence({
    execution,
    modules: modulePersistence(store).modules,
  });
}

/**
 * The local library as Works opens it, over the Module store under `root`.
 * With `execution`, saves are runs that record their evidence and missing
 * results are recovered first, as in Works; without, nothing is recorded.
 */
export async function openTestLocalLibrary(
  root: string,
  options: ModuleStoreOptions & {
    readonly execution?: Pick<WorksExecution, "dispatch" | "runs">;
  } = {}
) {
  const store = await openModuleStore(root, options);
  let saves = unrecordedSaves;
  if (options.execution) {
    const evidence = recordedSaves(options.execution, store);
    // Works recovers missing results before anything saves.
    await evidence.recoverAll();
    saves = evidence;
  }
  const library = await openLocalModuleLibrary(root, {
    records: createModuleRecords(store),
    saves,
  });
  return { library, saves, store };
}
