import type { MutationAuthorizationResult } from "./operator-readiness";
import type { InternalizeSymbolPlan, MutationEdit, PlanBlocker } from "./types";

/**
 * One internalize opportunity, as `atlas plan` names it: by its opportunity
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

/** What `atlas plan` answers for one site; `--json` prints it as is. */
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
 * A part of an authorization that moved since `atlas plan` recorded it, in
 * the order a fix is looked for: the sources (with the files that moved),
 * the rules, the mutator's capabilities, the verification, the plan, and
 * the rollback. `atlas-version`: every part is the same, so the hash itself
 * changed, which only another Atlas does.
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
    | "atlas-version";
}

/** Why apply would not, or did not, write; nothing was written. */
export type ApplyRefusal =
  /** Authorizing again now, under the configuration's rules, did not authorize the plan. */
  | Exclude<MutationAuthorizationResult, { kind: "authorized" }>
  /** It authorizes, but not as the record says. */
  | { kind: "authorization-changed"; parts: MovedPart[] }
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

/** What `atlas apply` answers for one site; `--json` prints it as is. */
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
  /** The symbol, as a facet: `path#name`. */
  site: string;
  status: "preview" | "refused";
}
