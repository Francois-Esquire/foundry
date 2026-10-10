import type { MutationAuthorizationResult } from "./operator-readiness";
import type { InternalizeSymbolPlan } from "./types";

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
