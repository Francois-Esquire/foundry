import { percentile } from "./churn";
import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type {
  DependencyGravity,
  FileChurn,
  FileHotspot,
  FunctionComplexity,
  HotspotArchitecture,
  HotspotComplexity,
  HotspotReport,
  HotspotSignal,
  SurfaceReport,
} from "./types";

// Hotspots: files where frequent change meets structural complexity. Pure
// composition over V6.0 churn and V4 local complexity; module gravity only
// decorates. The commit gate is mandatory, the complexity gates are OR-ed,
// and nothing here is scored or recommended.

export type HotspotSource = Pick<
  SurfaceReport,
  "target" | "churn" | "localComplexity" | "dependencyGravity"
>;

function emptyComplexity(): HotspotComplexity {
  return {
    controlFlowDecisions: { max: 0, total: 0 },
    expressionDecisions: { max: 0, total: 0 },
    functions: 0,
    nesting: { max: 0 },
    statements: { max: 0, total: 0 },
  };
}

/** Fold V4 function records to one vector per file: totals plus the worst function. */
function complexityByFile(
  functions: FunctionComplexity[]
): Map<string, HotspotComplexity> {
  const byFile = new Map<string, HotspotComplexity>();
  for (const fn of functions) {
    let file = byFile.get(fn.file);
    if (file === undefined) {
      file = emptyComplexity();
      byFile.set(fn.file, file);
    }
    const { decisions, nesting, statements } = fn.metrics;
    file.functions += 1;
    file.controlFlowDecisions.total += decisions.controlFlow;
    file.controlFlowDecisions.max = Math.max(
      file.controlFlowDecisions.max,
      decisions.controlFlow
    );
    file.expressionDecisions.total += decisions.expression;
    file.expressionDecisions.max = Math.max(
      file.expressionDecisions.max,
      decisions.expression
    );
    file.nesting.max = Math.max(file.nesting.max, nesting.max);
    file.statements.total += statements;
    file.statements.max = Math.max(file.statements.max, statements);
  }
  return byFile;
}

function architectureOf(
  module: DependencyGravity | undefined,
  packageName: string | undefined
): HotspotArchitecture | undefined {
  if (module === undefined && packageName === undefined) {
    return undefined;
  }
  return {
    ...(module !== undefined && {
      moduleGravity: {
        fanIn: module.direct.fanIn,
        fanOut: module.direct.fanOut,
        transitiveDependencies: module.transitive.dependencies,
        transitiveDependents: module.transitive.dependents,
      },
    }),
    ...(packageName !== undefined && { package: packageName }),
  };
}

function signalsOf(
  complexity: HotspotComplexity,
  module: DependencyGravity | undefined,
  policy: AnalysisConfig["hotspots"]
): HotspotSignal[] {
  const { complexity: gates } = policy.gates;
  const signals: HotspotSignal[] = ["frequent-change"];
  if (complexity.controlFlowDecisions.max >= gates.minMaxControlFlowDecisions) {
    signals.push("branch-heavy");
  }
  if (complexity.nesting.max >= gates.minMaxNesting) {
    signals.push("deep-control-flow");
  }
  if (
    complexity.controlFlowDecisions.total >=
      gates.minTotalControlFlowDecisions &&
    complexity.functions >= gates.minFunctionsForDense
  ) {
    signals.push("complexity-dense");
  }
  if (
    module !== undefined &&
    (module.direct.fanIn >= policy.architecture.minModuleFanIn ||
      module.direct.fanOut >= policy.architecture.minModuleFanOut)
  ) {
    signals.push("architecturally-central");
  }
  return signals;
}

/**
 * Eligibility: an eligible file kind, commit percentile at or above the
 * gate, and at least one complexity condition — max control-flow decisions,
 * max nesting, or total control-flow decisions (the dense form also needs
 * its function-count floor). Expression decisions (`&&`, `||`, ternaries)
 * never gate, so JSX-heavy render code does not qualify on syntax alone.
 */
function qualifies(
  file: FileChurn,
  complexity: HotspotComplexity,
  policy: AnalysisConfig["hotspots"]
): boolean {
  const { gates } = policy;
  if (file.rank.commitPercentile < gates.minCommitPercentile) {
    return false;
  }
  const c = gates.complexity;
  return (
    complexity.controlFlowDecisions.max >= c.minMaxControlFlowDecisions ||
    complexity.nesting.max >= c.minMaxNesting ||
    (complexity.controlFlowDecisions.total >= c.minTotalControlFlowDecisions &&
      complexity.functions >= c.minFunctionsForDense)
  );
}

export function analyzeHotspots(
  source: HotspotSource,
  config: AnalysisConfig = ANALYSIS_CONFIG
): HotspotReport {
  const { churn } = source;
  if (!churn.available) {
    return { available: false, reason: churn.reason };
  }
  const policy = config.hotspots;
  const complexity = complexityByFile(source.localComplexity.functions);
  const modules = new Map(
    source.dependencyGravity.modules.map((module) => [module.node.id, module])
  );
  const eligible = churn.files.filter((file) =>
    policy.eligibleKinds.includes(file.kind)
  );
  const complexityOf = (file: FileChurn) =>
    complexity.get(file.file) ?? emptyComplexity();
  const maxControlFlow = eligible
    .map((file) => complexityOf(file).controlFlowDecisions.max)
    .sort((a, b) => a - b);

  const files: FileHotspot[] = [];
  for (const file of eligible) {
    const vector = complexityOf(file);
    if (!qualifies(file, vector, policy)) {
      continue;
    }
    const module = modules.get(file.file);
    const architecture = architectureOf(module, source.target.name);
    files.push({
      complexity: vector,
      evolution: {
        additions: file.additions,
        commitPercentile: file.rank.commitPercentile,
        commits: file.commits,
        deletions: file.deletions,
        lineChurnPercentile: file.rank.lineChurnPercentile,
        linesChanged: file.linesChanged,
        ...(file.lastChangedAt !== undefined && {
          lastChangedAt: file.lastChangedAt,
        }),
        ...(file.daysSinceLastChange !== undefined && {
          daysSinceLastChange: file.daysSinceLastChange,
        }),
      },
      file: file.file,
      kind: file.kind,
      ...(architecture !== undefined && { architecture }),
      rank: {
        commitPercentile: file.rank.commitPercentile,
        complexityPercentile: percentile(
          maxControlFlow,
          vector.controlFlowDecisions.max
        ),
        lineChurnPercentile: file.rank.lineChurnPercentile,
      },
      signals: signalsOf(vector, module, policy),
    });
  }
  files.sort(
    (a, b) =>
      b.evolution.commitPercentile - a.evolution.commitPercentile ||
      b.evolution.commits - a.evolution.commits ||
      b.complexity.controlFlowDecisions.max -
        a.complexity.controlFlowDecisions.max ||
      a.file.localeCompare(b.file)
  );
  const above = (threshold: number) =>
    eligible.filter((file) => file.rank.commitPercentile >= threshold).length;
  return {
    available: true,
    files,
    summary: {
      eligibleSourceFiles: eligible.length,
      filesAboveCommitP90: above(0.9),
      filesAboveCommitP95: above(0.95),
      hotspotShare: eligible.length === 0 ? 0 : files.length / eligible.length,
      hotspots: files.length,
    },
    target: source.target.name ?? source.target.path,
    windowDays: churn.history.windowDays,
  };
}
