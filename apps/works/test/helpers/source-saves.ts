import type { ArtifactStore } from "@foundry/artifacts/store";
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

export const unrecordedSaves: SourceSaves = {
  admit: () => Promise.resolve(),
  async run(save, commit) {
    const { value } = await commit(
      {
        actor: save.actor,
        at: new Date().toISOString(),
        kind: save.kind,
        runId: "unrecorded",
      },
      () => undefined
    );
    return value;
  },
};

export function recordedSaves(
  execution: Pick<WorksExecution, "dispatch" | "runs">,
  store: ArtifactStore
): SourceEvidence {
  return new SourceEvidence({
    execution,
    modules: modulePersistence(store).modules,
  });
}

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
    await evidence.recoverAll();
    saves = evidence;
  }
  const library = await openLocalModuleLibrary(root, {
    records: createModuleRecords(store),
    saves,
  });
  return { library, saves, store };
}
