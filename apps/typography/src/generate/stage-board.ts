/**
 * The stages of one generation as a person watches them: Analyse and Plan,
 * which the Generate place does before a run, then the stages the pipeline
 * runner reports. A failure belongs to the stage that was running.
 */
import {
  RUN_STAGES,
  type StageName,
  type StageProgress,
} from "~/generation/pipeline/run";

export type StageId = "analyse" | "plan" | StageName;

const STAGE_ORDER: readonly StageId[] = ["analyse", "plan", ...RUN_STAGES];

export const STAGE_NAMES: Readonly<Record<StageId, string>> = {
  analyse: "Analyse",
  compose: "Compose",
  extract: "Extract",
  generate: "Generate",
  integrate: "Integrate",
  normalise: "Normalise",
  plan: "Plan",
  refine: "Refine",
  validate: "Validate",
};

export type StageStatus =
  | "failed"
  | "finished"
  | "running"
  | "skipped"
  | "waiting";

export interface StageLine {
  /** What the stage did, why it was skipped, or why it failed. */
  readonly detail?: string;
  readonly elapsedMs?: number;
  readonly stage: StageId;
  readonly status: StageStatus;
}

export type StageBoard = readonly StageLine[];

/** A stage that ended, as the board and the run record keep it. */
export interface StageOutcome {
  readonly detail: string;
  readonly elapsedMs: number;
  readonly stage: StageId;
  readonly status: "finished" | "skipped";
}

/** Every stage waiting. */
export const emptyBoard = (): StageBoard =>
  STAGE_ORDER.map((stage) => ({ stage, status: "waiting" }));

const withLine = (board: StageBoard, line: StageLine): StageBoard =>
  board.map((existing) => (existing.stage === line.stage ? line : existing));

export const startStage = (board: StageBoard, stage: StageId): StageBoard =>
  withLine(board, { stage, status: "running" });

export const endStage = (
  board: StageBoard,
  outcome: StageOutcome
): StageBoard => withLine(board, outcome);

/** Follows the pipeline runner's own progress reports. */
export const followProgress = (
  board: StageBoard,
  progress: StageProgress
): StageBoard =>
  withLine(board, {
    detail: progress.detail,
    elapsedMs: progress.elapsedMs,
    stage: progress.stage,
    status: progress.status === "started" ? "running" : progress.status,
  });

export interface StageFailure {
  readonly reason: string;
  readonly stage: StageId;
}

/**
 * Marks the failure on the stage that was running. The runner throws without
 * naming a stage, and the one it had started and not finished is the one
 * that failed. With nothing running, the first waiting stage never began.
 * A caller that knows the stage, such as a refused proposal, names it.
 */
export const failBoard = (
  board: StageBoard,
  reason: string,
  known?: StageId
): { readonly board: StageBoard; readonly failure: StageFailure } => {
  const at =
    board.find((line) => line.status === "running") ??
    board.find((line) => line.status === "waiting");
  const stage = known ?? at?.stage ?? "integrate";
  return {
    board: withLine(board, { detail: reason, stage, status: "failed" }),
    failure: { reason, stage },
  };
};

/** Milliseconds as a person reads them: 0.4 ms, 38 ms, 1.2 s. */
export const formatElapsed = (elapsedMs: number): string => {
  if (elapsedMs >= 1000) {
    return `${(elapsedMs / 1000).toFixed(1)} s`;
  }
  return elapsedMs >= 10
    ? `${Math.round(elapsedMs)} ms`
    : `${Number(elapsedMs.toFixed(1))} ms`;
};
