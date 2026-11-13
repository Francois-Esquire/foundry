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

// Native reads for fold planning, and the planner's native entry. The reads
// themselves are `fold-inputs.ts` over a reader; the planning, over
// `FoldInputs`, is `fold-planning.ts`.

const NATIVE_FOLD_READER: FoldReader = {
  ...nativeRepositoryReader,
  entries: nativeDirectoryEntries,
  readConfigText: (file) => ts.sys.readFile(file),
};

/**
 * Read the fold planner's inputs natively: each source package's walk and
 * configuration files, each destination name's boundary and its manifest,
 * tsconfig and `src` entries, and the root's workspace patterns. Reads that
 * throw are kept as errors for planning to raise.
 */
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

/**
 * Fold plans for a boundary. Planning reads only `prepared` when it is
 * given; without it, exactly this fold's source and destination are read
 * natively first, once a fold opportunity is known to exist.
 */
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
