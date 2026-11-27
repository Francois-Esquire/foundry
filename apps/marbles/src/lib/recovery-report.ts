import { z } from "zod";

const RECOVERY_STEPS = [
  "processes",
  "containers",
  "runs",
  "activities",
  "artifacts",
] as const;
export type RecoveryStepName = (typeof RECOVERY_STEPS)[number];

export interface RecoveryStep {
  readonly detail: string;
  readonly outcome: "done" | "failed" | "skipped";
  readonly step: RecoveryStepName;
}

export interface RecoveryReport {
  readonly at: string;
  readonly steps: readonly RecoveryStep[];
}

export const recoveryReportSchema = z.object({
  at: z.string(),
  steps: z.array(
    z.object({
      detail: z.string(),
      outcome: z.enum(["done", "failed", "skipped"]),
      step: z.enum(RECOVERY_STEPS),
    })
  ),
});

export interface RecoveryLog {
  record(report: RecoveryReport): Promise<void>;
}
