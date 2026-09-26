import type { AnalysisConfig } from "./config";
import {
  ANALYSIS_CONFIG,
  WORKSPACE_INTELLIGENCE_POLICY_VERSION,
} from "./config";
import { analyzeWorkspaceConcepts } from "./workspace-concepts";
import { analyzeWorkspaceGraph } from "./workspace-graph";
import { analyzeWorkspacePatterns } from "./workspace-patterns";
import type { WorkspaceReport } from "./workspace-types";

/** Attaches every derived workspace layer (V9.1 graph, V9.2 concepts, V9.3 patterns) under one policy stamp. */
export function analyzeWorkspace(
  workspace: WorkspaceReport,
  config: AnalysisConfig = ANALYSIS_CONFIG
): WorkspaceReport {
  const graph = analyzeWorkspaceGraph(workspace, config);
  const concepts = analyzeWorkspaceConcepts(workspace, graph, config);
  const patterns = analyzeWorkspacePatterns(workspace, graph, concepts, config);
  return {
    ...workspace,
    intelligence: {
      concepts,
      graph,
      patterns,
      policyVersion: WORKSPACE_INTELLIGENCE_POLICY_VERSION,
    },
  };
}
