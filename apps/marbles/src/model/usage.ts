/** An amount in one currency. */
export interface Money {
  readonly amount: number;
  readonly currency: string;
}

/**
 * What a set of recorded turns consumed. Every figure is a sum of the turns'
 * own facts. A turn without a price is counted, never read as zero; no turns
 * at all means nothing was recorded, which is not a zero cost either.
 */
export interface UsageTotal {
  /** Tokens at list prices, per currency. */
  readonly estimated: readonly Money[];
  /** Turns that ran but whose usage was not recorded (lost, or recovered from a transcript): never priced, never read as zero. */
  readonly missing: number;
  /** Providers' own figures, per currency. */
  readonly reported: readonly Money[];
  /** Summed over the turns that reported tokens; `input` includes cache reads and writes. */
  readonly tokens: {
    readonly cachedInput: number;
    readonly cacheWrite: number;
    readonly input: number;
    readonly output: number;
    readonly total: number;
  };
  readonly turns: number;
  /**
   * Recovered turns no durable record attributes, that are not among
   * `turns` and may belong here: it is incomplete while above zero.
   */
  readonly unattributed: number;
  /** Saved turns with neither a reported nor an estimated cost. */
  readonly unpriced: number;
  /** Records that could not be read and may belong to this total: it is incomplete while above zero. */
  readonly unreadable: number;
  /** Turns whose token counts were not reported. */
  readonly untokened: number;
}

/** A step's own turns, and its own with every descendant's. */
export interface StepUsage {
  readonly direct: UsageTotal;
  readonly inclusive: UsageTotal;
}

/** A total under one workflow, agent, or model. */
export interface UsageGroup {
  readonly id: string;
  readonly total: UsageTotal;
}

/** Usage across this workspace: its runs, and sessions opened outside any run. */
export interface WorkspaceUsage {
  /** Every turn, in runs or not, by agent. */
  readonly byAgent: readonly UsageGroup[];
  /** Turns in runs, by the run's root definition. */
  readonly byWorkflow: readonly UsageGroup[];
  /** Turns a saved fact or marker places outside any run: no workflow to attribute. */
  readonly outsideRuns: UsageTotal;
  /** Turns recovered from session transcripts because no fact was saved. */
  readonly recovered: number;
  readonly total: UsageTotal;
  /** Recovered turns whose run, or no run, nothing durable proves: in `total` and `byAgent`, and noted on the totals they may belong to. */
  readonly unattributed: number;
  /** Records that could not be read: every total here is partial while this is above zero. */
  readonly unreadable: number;
  /** Turns not saved, kept only in this process: a restart cannot recover them. */
  readonly unsaved: number;
}
