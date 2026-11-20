import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";
import { auditRun } from "~/main/execution/audit";
import type { ArtifactSummary } from "~/shared/artifacts";
import type { AuditGap, AuditRun } from "~/shared/audit";
import type { ModuleSummary } from "~/shared/modules";
import { runAuditScenario } from "./audit-scenario";

export interface AuditFixture {
  readonly artifacts: readonly ArtifactSummary[];
  readonly gaps: readonly AuditGap[];
  readonly moduleId: string;
  readonly modules: readonly ModuleSummary[];
  readonly runs: readonly AuditRun[];
  readonly turnRunId: string;
}

declare module "vitest" {
  interface ProvidedContext {
    auditFixture: AuditFixture;
  }
}

export default async function setup(project: TestProject) {
  const directory = await mkdtemp(path.join(tmpdir(), "works-audit-fixture-"));
  const scenario = await runAuditScenario(directory);
  try {
    project.provide("auditFixture", {
      artifacts: await scenario.works.rpc.artifacts.list(),
      gaps: scenario.execution.runs.gaps().map((gap) => ({ ...gap })),
      moduleId: scenario.moduleId,
      modules: await scenario.library.list(),
      runs: scenario.execution.runs.list().map(auditRun),
      turnRunId: scenario.turnRunId,
    });
  } finally {
    await scenario.close();
  }
  return () => rm(directory, { force: true, recursive: true });
}
