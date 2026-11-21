import { noFoldInputs } from "../../../src/lib/fold-inputs";
import { readFoldInputs } from "../../../src/lib/fold-plan";
import type { PackageLocalReport } from "../../../src/lib/package-local-types";
import type { PreparedWorkspaceInputs } from "../../../src/lib/workspace-analysis";
import {
  analyzeWorkspaceToFolds,
  completeWorkspace,
  foldRequests,
} from "../../../src/lib/workspace-analysis";
import type { WorkspaceSurfaceDerivation } from "../../../src/lib/workspace-derive-types";

export function analyzePrepared(
  locals: readonly PackageLocalReport[],
  prepared: PreparedWorkspaceInputs,
  pure: <T>(run: () => T) => T = (run) => run()
): WorkspaceSurfaceDerivation {
  const stage = pure(() => analyzeWorkspaceToFolds(locals, prepared));
  const { destinations, sources } = foldRequests(stage);
  const fold =
    sources.length === 0
      ? noFoldInputs(prepared.root)
      : readFoldInputs(prepared.root, sources, destinations);
  return pure(() => completeWorkspace(stage, fold));
}
