import type { Boundary } from "./boundary";
import { classifyFile } from "./churn";
import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type { GitHistory } from "./git-history";
import {
  eligibleCommits,
  ownerResolver,
  PAIR,
  packageEdgesOf,
} from "./history-commits";
import { adjacency, Reachability } from "./reachability";
import type {
  ChangeCouplingPair,
  ChangeCouplingReport,
  ChurnFileKind,
  CouplingContext,
  FileChangeCouplingPair,
  FileCouplingSummary,
  PackageChangeCoupling,
  StaticPathRelation,
  StaticRelation,
  WorkspaceModuleGraph,
} from "./types";

// Change coupling: pairs of current files (and their owning packages) that
// repeatedly appear in the same commits, with the static graph's answer for
// each pair — the direct edge, and whether any path connects them at all.
// Pairs are generated from commit membership, never from an all-files scan.
// Evidence only: support, both conditionals, Jaccard.

export interface ChangeCouplingSource {
  boundary: Boundary;
  graph: WorkspaceModuleGraph;
}

interface PairSupport {
  count: number;
  lastAt: string;
}

class PairTable {
  readonly commits = new Map<string, number>();
  readonly pairs = new Map<string, PairSupport>();

  /** `nodes` must be unique and sorted. */
  record(nodes: string[], timestamp: string): void {
    for (const node of nodes) {
      this.commits.set(node, (this.commits.get(node) ?? 0) + 1);
    }
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const key = `${nodes[i]}${PAIR}${nodes[j]}`;
        const support = this.pairs.get(key);
        if (support === undefined) {
          this.pairs.set(key, { count: 1, lastAt: timestamp });
        } else {
          support.count += 1;
          if (Date.parse(timestamp) > Date.parse(support.lastAt)) {
            support.lastAt = timestamp;
          }
        }
      }
    }
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Direct edge and reachability for one node level (modules or packages). */
class StaticGraph {
  private readonly reach: Reachability;

  constructor(
    private readonly edges: Set<string>,
    private readonly measured: Set<string>
  ) {
    this.reach = new Reachability(
      adjacency([...edges].map((edge) => edge.split(PAIR) as [string, string]))
    );
  }

  relation(left: string, right: string): StaticRelation {
    if (!(this.measured.has(left) && this.measured.has(right))) {
      return "unmeasured";
    }
    const forward = this.edges.has(`${left}${PAIR}${right}`);
    const backward = this.edges.has(`${right}${PAIR}${left}`);
    if (forward && backward) {
      return "bidirectional";
    }
    if (forward) {
      return "left-to-right";
    }
    if (backward) {
      return "right-to-left";
    }
    return "none";
  }

  path(left: string, right: string, relation: StaticRelation) {
    if (relation === "unmeasured") {
      return "unmeasured";
    }
    if (relation !== "none") {
      return "direct";
    }
    return this.reach.connected(left, right) ? "indirect" : "none";
  }
}

const KIND_CONTEXTS: Partial<Record<string, CouplingContext>> = {
  "config-config": "config-config",
  "source-source": "source-source",
  "source-test": "source-test",
  "test-test": "test-test",
};

function contextOf(left: ChurnFileKind, right: ChurnFileKind): CouplingContext {
  if (left === "story" || right === "story") {
    return "story-related";
  }
  return KIND_CONTEXTS[[left, right].sort().join("-")] ?? "mixed";
}

function strongPairs(
  table: PairTable,
  gates: AnalysisConfig["changeCoupling"]["gates"],
  involves: (node: string) => boolean,
  graph: StaticGraph
): ChangeCouplingPair[] {
  const pairs: ChangeCouplingPair[] = [];
  for (const [key, support] of table.pairs) {
    const [left, right] = key.split(PAIR) as [string, string];
    if (!(involves(left) || involves(right))) {
      continue;
    }
    if (support.count < gates.minCoChangeCommits) {
      continue;
    }
    const leftCommits = table.commits.get(left) ?? 0;
    const rightCommits = table.commits.get(right) ?? 0;
    const leftConditional = ratio(support.count, leftCommits);
    const rightConditional = ratio(support.count, rightCommits);
    const jaccard = ratio(
      support.count,
      leftCommits + rightCommits - support.count
    );
    if (
      leftConditional < gates.minConditional &&
      rightConditional < gates.minConditional &&
      jaccard < gates.minJaccard
    ) {
      continue;
    }
    const staticRelation = graph.relation(left, right);
    pairs.push({
      coChangeCommits: support.count,
      jaccard,
      lastCoChangedAt: support.lastAt,
      left,
      leftCommits,
      leftConditional,
      right,
      rightCommits,
      rightConditional,
      staticPath: graph.path(left, right, staticRelation),
      staticRelation,
    });
  }
  return pairs.sort(
    (a, b) =>
      b.coChangeCommits - a.coChangeCommits ||
      b.jaccard - a.jaccard ||
      Math.max(b.leftConditional, b.rightConditional) -
        Math.max(a.leftConditional, a.rightConditional) ||
      a.left.localeCompare(b.left) ||
      a.right.localeCompare(b.right)
  );
}

function fileSummaries(
  pairs: FileChangeCouplingPair[],
  inTarget: (file: string) => boolean
): FileCouplingSummary[] {
  const byFile = new Map<string, FileCouplingSummary>();
  const consider = (
    file: string,
    partner: string,
    conditional: number,
    jaccard: number
  ) => {
    if (!inTarget(file)) {
      return;
    }
    const current = byFile.get(file);
    if (current === undefined) {
      byFile.set(file, {
        file,
        partners: 1,
        strongest: { conditional, file: partner, jaccard },
      });
      return;
    }
    current.partners += 1;
    const best = current.strongest;
    if (
      jaccard > best.jaccard ||
      (jaccard === best.jaccard &&
        (conditional > best.conditional ||
          (conditional === best.conditional &&
            partner.localeCompare(best.file) < 0)))
    ) {
      current.strongest = { conditional, file: partner, jaccard };
    }
  };
  for (const pair of pairs) {
    consider(pair.left, pair.right, pair.leftConditional, pair.jaccard);
    consider(pair.right, pair.left, pair.rightConditional, pair.jaccard);
  }
  return [...byFile.values()].sort(
    (a, b) => b.partners - a.partners || a.file.localeCompare(b.file)
  );
}

/**
 * Build coupling from the already-collected history. Commits are limited to
 * the churn window and the shared oversized rule; both file and package
 * pairs are counted once per commit. Reported pairs touch the target on at
 * least one side; commit counts are repository-wide over the same
 * considered commits.
 */
export function analyzeChangeCoupling(
  history: GitHistory,
  source: ChangeCouplingSource,
  config: AnalysisConfig = ANALYSIS_CONFIG
): ChangeCouplingReport {
  if (!history.available) {
    return { available: false, reason: history.reason };
  }
  const { boundary, graph } = source;
  const { gates } = config.changeCoupling;
  const { windowDays } = config.churn;
  const ownerOf = ownerResolver(graph, boundary.root);

  const files = new PairTable();
  const packages = new PairTable();
  let commitsConsidered = 0;
  let commitsExcluded = 0;
  for (const eligible of eligibleCommits(history, {
    ownerOf,
    policy: config.history,
    windowDays,
  })) {
    if (eligible.oversized) {
      commitsExcluded += 1;
      continue;
    }
    commitsConsidered += 1;
    files.record(eligible.files, eligible.commit.timestamp);
    packages.record(eligible.packages, eligible.commit.timestamp);
  }

  const moduleGraph = new StaticGraph(
    new Set(graph.edges.map((edge) => `${edge.fromFile}${PAIR}${edge.toFile}`)),
    new Set(graph.modules)
  );
  const packageGraph = new StaticGraph(
    packageEdgesOf(graph),
    new Set(Object.values(graph.owners))
  );

  const inTarget = (file: string) =>
    boundary.relPath === "" ||
    file === boundary.relPath ||
    file.startsWith(`${boundary.relPath}/`);
  const targetPackage = boundary.packageName ?? boundary.relPath;

  const filePairs: FileChangeCouplingPair[] = strongPairs(
    files,
    gates,
    inTarget,
    moduleGraph
  ).map((pair) => {
    const leftPackage = ownerOf(pair.left);
    const rightPackage = ownerOf(pair.right);
    return {
      ...pair,
      context: contextOf(classifyFile(pair.left), classifyFile(pair.right)),
      leftPackage,
      rightPackage,
      scope: leftPackage === rightPackage ? "same-package" : "cross-package",
    };
  });
  const packagePairs: PackageChangeCoupling[] = strongPairs(
    packages,
    gates,
    (node) => node === targetPackage,
    packageGraph
  );
  const count = (
    pairs: ChangeCouplingPair[],
    key: "staticRelation" | "staticPath",
    value: StaticRelation | StaticPathRelation
  ) => pairs.filter((pair) => pair[key] === value).length;

  return {
    available: true,
    filePairs,
    files: fileSummaries(filePairs, inTarget),
    history: {
      commitsConsidered,
      commitsExcluded,
      observedFilePairs: files.pairs.size,
      oversized: config.history.oversized,
      windowDays,
    },
    packagePairs,
    summary: {
      crossPackagePairs: filePairs.filter((p) => p.scope === "cross-package")
        .length,
      filePairs: filePairs.length,
      filePairsWithoutStaticEdge: count(filePairs, "staticRelation", "none"),
      filePairsWithoutStaticPath: count(filePairs, "staticPath", "none"),
      packagePairs: packagePairs.length,
      packagePairsWithoutStaticEdge: count(
        packagePairs,
        "staticRelation",
        "none"
      ),
      samePackagePairs: filePairs.filter((p) => p.scope === "same-package")
        .length,
    },
    target: targetPackage,
  };
}
