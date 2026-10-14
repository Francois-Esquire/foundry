import type { MutationAuthorizationResult } from "./operator-readiness";
import type { OperatorPlanReadiness } from "./operator-readiness-types";
import type { RuleRefusal } from "./rules";
import type {
  InternalizeSymbolPlan,
  MutationEdit,
  PlanBlocker,
  VerificationResult,
} from "./types";

/**
 * One internalize opportunity, as `spyglass plan` names it: by its opportunity
 * id, its saved plan's id, or the bare `path#name` of its symbol.
 */
export interface Site {
  /** The opportunity's id: `internalize-symbol:<path#name>`. */
  opportunity: string;
  /** The symbol, as a facet: `path#name`. */
  place: string;
  /** The saved plan's id: `plan:internalize-symbol:<path#name>`. */
  planId: string;
}

/** What `spyglass plan` answers for one site; `--json` prints it as is. */
export interface PlanSiteResult {
  /** The opportunity's id. */
  opportunity: string;
  /** The saved plan, as the package report holds it. */
  plan: InternalizeSymbolPlan;
  /** Where the authorization record was saved; only when `verdict` is `authorized`. */
  record?: string;
  /** The symbol, as a facet: `path#name`. */
  site: string;
  /** `authorizeMutationPlan`'s answer, as it returned it. */
  verdict: MutationAuthorizationResult;
}

/**
 * A part of an authorization that moved since `spyglass plan` recorded it, in
 * the order a fix is looked for: the sources (with the files that moved),
 * the rules, the mutator's capabilities, the verification, the plan, and
 * the rollback. `spyglass-version`: every part is the same, so the hash itself
 * changed, which only another Spyglass does.
 */
export interface MovedPart {
  /** For `source`: the files whose bytes moved, appeared, or went. */
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

/** Why apply would not write; nothing was written by this run, except a restore. */
export type ApplyRefusal =
  /**
   * An earlier apply did not finish. `writing`: it was interrupted while it
   * wrote, and this run restored `restored` from its journal; `skipped` were
   * already as they were. `verified`:
   * the write passed its checks, but the scan after it did not publish.
   */
  | {
      kind: "pending-write";
      phase: "writing" | "verified";
      /** The files put back from the journal. */
      restored?: string[];
      site: string;
      /** Files the journal names that already held their original bytes. */
      skipped?: string[];
    }
  /** Authorizing again now, under the configuration's rules, did not authorize the plan: `authorizeMutationPlan`'s answer. */
  | { kind: "refused-by-rule"; refused: RuleRefusal[] }
  | { kind: "not-executable"; reason: string }
  | { kind: "readiness"; readiness: OperatorPlanReadiness }
  /** It authorizes, but not as the record says. */
  | { kind: "authorization-changed"; parts: MovedPart[] }
  /** The saved dataset no longer describes the workspace, or cannot be shown to; "before" is its report, so apply needs a scan first. */
  | { kind: "stale-dataset"; reason: string }
  /** The rollback cannot restore every file the mutator writes. */
  | { kind: "rollback"; reason: string }
  /** A file the mutator writes has uncommitted changes. */
  | { kind: "dirty"; files: string[] }
  /** A write needs Git to tell a dirty file. */
  | { kind: "no-git"; reason: string }
  /** The mutator's own analysis of the package, run fresh, disagrees with the saved plan. */
  | {
      kind: "revalidation";
      status: "blocked" | "stale" | "unsupported";
      blockers: PlanBlocker[];
    };

/** The scan after a write. `failed`: the sources hold the verified write, and the published dataset is the one from before it. */
export interface ApplyScan {
  durationMs: number;
  error?: string;
  output: string;
  status: "published" | "failed";
}

/** What `spyglass apply` answers for one site; `--json` prints it as is. */
export interface ApplyResult {
  /** What the write would change, file by file; the same in both modes. */
  changedFiles: string[];
  /** Each statement the mutator edits, before and after. */
  edits: MutationEdit[];
  mode: "preview" | "write";
  /** The saved plan's id. */
  planId: string;
  /** Why it stopped; only when `status` is `refused`. */
  refusal?: ApplyRefusal;
  /** The scan after the write; only when `status` is `applied`. */
  scan?: ApplyScan;
  /** The symbol, as a facet: `path#name`. */
  site: string;
  /**
   * `preview`: nothing written. `refused`: nothing written. `applied`: the
   * write passed every check. `rolled-back`: a check failed after the write,
   * and every written file was restored.
   */
  status: "preview" | "refused" | "applied" | "rolled-back";
  /** How long the workspace's own scripts ran: once under the lock before the write, and once after it. */
  timings?: { afterMs: number; baselineMs: number };
  /** Every check after the write: TypeScript, the structural proof, and the scripts run again. */
  verification?: VerificationResult;
}
