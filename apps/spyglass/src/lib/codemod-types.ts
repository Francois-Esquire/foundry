import type { MutationAuthorizationResult } from "./operator-readiness";
import type { OperatorPlanReadiness } from "./operator-readiness-types";
import type { RuleRefusal } from "./rules";
import type {
  InternalizeSymbolPlan,
  MutationEdit,
  PlanBlocker,
  VerificationResult,
} from "./types";

export interface Site {
  opportunity: string;
  place: string;
  planId: string;
}

export interface PlanSiteResult {
  opportunity: string;
  plan: InternalizeSymbolPlan;
  record?: string;
  site: string;
  verdict: MutationAuthorizationResult;
}

export interface MovedPart {
  files?: string[];
  part:
    | "source"
    | "rule"
    | "capability"
    | "verification"
    | "plan"
    | "rollback"
    | "spyglass-version";
}

export type ApplyRefusal =
  | {
      kind: "pending-write";
      phase: "writing" | "verified";
      restored?: string[];
      site: string;
      skipped?: string[];
    }
  | { kind: "refused-by-rule"; refused: RuleRefusal[] }
  | { kind: "not-executable"; reason: string }
  | { kind: "readiness"; readiness: OperatorPlanReadiness }
  | { kind: "authorization-changed"; parts: MovedPart[] }
  | { kind: "stale-dataset"; reason: string }
  | { kind: "rollback"; reason: string }
  | { kind: "dirty"; files: string[] }
  | { kind: "no-git"; reason: string }
  | {
      kind: "revalidation";
      status: "blocked" | "stale" | "unsupported";
      blockers: PlanBlocker[];
    };

export interface ApplyScan {
  durationMs: number;
  error?: string;
  output: string;
  status: "published" | "failed";
}

export interface ApplyResult {
  changedFiles: string[];
  edits: MutationEdit[];
  mode: "preview" | "write";
  planId: string;
  refusal?: ApplyRefusal;
  scan?: ApplyScan;
  site: string;
  status: "preview" | "refused" | "applied" | "rolled-back";
  timings?: { afterMs: number; baselineMs: number };
  verification?: VerificationResult;
}
