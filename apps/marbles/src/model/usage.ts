export interface Money {
  readonly amount: number;
  readonly currency: string;
}

export interface UsageTotal {
  readonly estimated: readonly Money[];
  readonly missing: number;
  readonly reported: readonly Money[];
  readonly tokens: {
    readonly cachedInput: number;
    readonly cacheWrite: number;
    readonly input: number;
    readonly output: number;
    readonly total: number;
  };
  readonly turns: number;
  readonly unattributed: number;
  readonly unpriced: number;
  readonly unreadable: number;
  readonly untokened: number;
}

export interface StepUsage {
  readonly direct: UsageTotal;
  readonly inclusive: UsageTotal;
}

export interface UsageGroup {
  readonly id: string;
  readonly total: UsageTotal;
}

export interface WorkspaceUsage {
  readonly byAgent: readonly UsageGroup[];
  readonly byWorkflow: readonly UsageGroup[];
  readonly outsideRuns: UsageTotal;
  readonly recovered: number;
  readonly total: UsageTotal;
  readonly unattributed: number;
  readonly unreadable: number;
  readonly unsaved: number;
}
