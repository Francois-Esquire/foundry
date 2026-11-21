import { ts } from "ts-morph";
import { nativeDirectoryEntries, nativeRepositoryReader } from "./boundary";
import type { Boundary } from "./boundary-model";
import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type { FoldReader } from "./fold-inputs";
import { readFoldInputsWith } from "./fold-inputs";
import type { FoldInputs } from "./fold-planning";
import { foldOpportunity, planFolds } from "./fold-planning";
import { createIgnorer } from "./ignore";
import type {
  FoldPackagePlan,
  ReductionOpportunity,
  SurfaceDependencies,
  SurfaceReport,
  SurfaceSymbol,
} from "./types";

const NATIVE_FOLD_READER: FoldReader = {
  ...nativeRepositoryReader,
  entries: nativeDirectoryEntries,
  readConfigText: (file) => ts.sys.readFile(file),
};

export function readFoldInputs(
  root: string,
  sources: readonly Boundary[],
  destinationNames: Iterable<string>
): FoldInputs {
  return readFoldInputsWith(
    NATIVE_FOLD_READER,
    createIgnorer(root),
    root,
    sources,
    destinationNames
  );
}

export function buildFoldPlans(
  boundary: Boundary,
  symbols: SurfaceSymbol[],
  dependencies: SurfaceDependencies,
  opportunities: ReductionOpportunity[],
  config: AnalysisConfig = ANALYSIS_CONFIG,
  prepared?: FoldInputs
): FoldPackagePlan[] {
  if (prepared !== undefined) {
    return planFolds(
      boundary,
      symbols,
      dependencies,
      opportunities,
      config,
      prepared
    );
  }
  const target = foldOpportunity(opportunities)?.target;
  if (target === undefined) {
    return [];
  }
  return planFolds(
    boundary,
    symbols,
    dependencies,
    opportunities,
    config,
    readFoldInputs(boundary.root, [boundary], [target.name])
  );
}

export function buildFoldPackagePlan(
  report: SurfaceReport,
  opportunity: ReductionOpportunity
): FoldPackagePlan {
  if (opportunity.operation !== "fold-package") {
    throw new Error(
      `buildFoldPackagePlan only selects fold-package plans (got ${opportunity.operation})`
    );
  }
  const plan = report.plans.find(
    (candidate): candidate is FoldPackagePlan =>
      candidate.operation === "fold-package" &&
      candidate.source.package === opportunity.subject.id
  );
  if (plan === undefined) {
    throw new Error(`No plan found for opportunity ${opportunity.id}`);
  }
  return plan;
}
