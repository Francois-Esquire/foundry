import type { RunUsageFact, UsageFact, UsageRecords } from "~/lib/usage";
import type {
  Money,
  StepUsage,
  UsageGroup,
  UsageTotal,
  WorkspaceUsage,
} from "~/model/usage";

function addMoney(sums: Map<string, number>, money: Money): void {
  sums.set(money.currency, (sums.get(money.currency) ?? 0) + money.amount);
}

function moneyOf(sums: ReadonlyMap<string, number>): Money[] {
  return [...sums]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amount]) => ({ amount, currency }));
}

export function totalOf(
  facts: Iterable<UsageFact>,
  unreadable = 0,
  unattributed = 0
): UsageTotal {
  const estimated = new Map<string, number>();
  const reported = new Map<string, number>();
  const tokens = {
    cachedInput: 0,
    cacheWrite: 0,
    input: 0,
    output: 0,
    total: 0,
  };
  let turns = 0;
  let untokened = 0;
  let unpriced = 0;
  let missing = 0;
  for (const fact of facts) {
    turns += 1;
    if (fact.tokens) {
      tokens.cachedInput += fact.tokens.cachedInput ?? 0;
      tokens.cacheWrite += fact.tokens.cacheWrite ?? 0;
      tokens.input += fact.tokens.input;
      tokens.output += fact.tokens.output;
      tokens.total += fact.tokens.total;
    } else {
      untokened += 1;
    }
    const { cost } = fact;
    if (fact.lost !== undefined) {
      missing += 1;
    } else if (
      cost.kind === "estimated" ||
      (cost.kind === "reported" && cost.estimate)
    ) {
      addMoney(estimated, cost);
    } else if (cost.kind === "reported") {
      addMoney(reported, cost);
    } else {
      unpriced += 1;
    }
  }
  return {
    estimated: moneyOf(estimated),
    missing,
    reported: moneyOf(reported),
    tokens,
    turns,
    unattributed,
    unpriced,
    unreadable,
    untokened,
  };
}

export interface MayBelong {
  readonly unattributed: number;
  readonly unreadable: number;
}

const NOTHING: MayBelong = { unattributed: 0, unreadable: 0 };

interface StepFacts {
  readonly children: Map<string, StepFacts>;
  readonly direct: RunUsageFact[];
}

function factsBelow(node: StepFacts): RunUsageFact[] {
  return [...node.direct, ...[...node.children.values()].flatMap(factsBelow)];
}

export function stepUsages(
  facts: readonly RunUsageFact[],
  mayBelong: MayBelong = NOTHING
): (path: readonly string[]) => StepUsage | undefined {
  const root: StepFacts = { children: new Map(), direct: [] };
  for (const fact of facts) {
    let node = root;
    for (const segment of fact.path) {
      let child = node.children.get(segment);
      if (!child) {
        child = { children: new Map(), direct: [] };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.direct.push(fact);
  }
  const { unattributed, unreadable } = mayBelong;
  const uncertain = unreadable > 0 || unattributed > 0;
  return (path) => {
    let node: StepFacts | undefined = path.length > 0 ? root : undefined;
    for (const segment of path) {
      node = node?.children.get(segment);
    }
    const inclusive = node ? factsBelow(node) : [];
    if (inclusive.length === 0 && !uncertain) {
      return;
    }
    return {
      direct: totalOf(node?.direct ?? [], unreadable, unattributed),
      inclusive: totalOf(inclusive, unreadable, unattributed),
    };
  };
}

function groups<FACT extends UsageFact>(
  facts: readonly FACT[],
  key: (fact: FACT) => string,
  mayBelong: (id: string, members: readonly FACT[]) => MayBelong,
  others: Iterable<string> = []
): UsageGroup[] {
  const grouped = new Map<string, FACT[]>();
  for (const fact of facts) {
    const id = key(fact);
    const list = grouped.get(id) ?? [];
    list.push(fact);
    grouped.set(id, list);
  }
  for (const id of others) {
    if (!grouped.has(id)) {
      grouped.set(id, []);
    }
  }
  return [...grouped]
    .flatMap(([id, members]) => {
      const { unattributed, unreadable } = mayBelong(id, members);
      return members.length === 0 && unreadable === 0 && unattributed === 0
        ? []
        : [{ id, total: totalOf(members, unreadable, unattributed) }];
    })
    .sort((a, b) => b.total.turns - a.total.turns || a.id.localeCompare(b.id));
}

export interface KnownRun {
  readonly createdAt: number;
  readonly definition: string;
  readonly endedAt?: number;
}

function mayHold(run: KnownRun | undefined, at: number): boolean {
  return (
    run === undefined ||
    (at >= run.createdAt && (run.endedAt === undefined || at <= run.endedAt))
  );
}

export function workspaceUsage(
  records: UsageRecords,
  workspaceId: string | undefined,
  known: {
    readonly runs?: ReadonlyMap<string, KnownRun>;
    readonly workflows?: Iterable<string>;
  } = {}
): {
  readonly byRun: ReadonlyMap<string, readonly RunUsageFact[]>;
  readonly mayBelongTo: (runId: string) => MayBelong;
  readonly usage: WorkspaceUsage;
} {
  const facts = records.facts.filter(
    (fact) => workspaceId === undefined || fact.workspaceId === workspaceId
  );
  const inRuns = facts.filter(
    (fact): fact is RunUsageFact => fact.scope === "run"
  );
  const unattributed = facts.filter((fact) => fact.scope === "unattributed");
  const runs = new Map(known.runs);
  const byRun = new Map<string, RunUsageFact[]>();
  const definitions = new Map(
    [...runs].map(([runId, run]) => [runId, run.definition])
  );
  for (const fact of inRuns) {
    const list = byRun.get(fact.runId) ?? [];
    list.push(fact);
    byRun.set(fact.runId, list);
    definitions.set(
      fact.runId,
      definitions.get(fact.runId) ?? fact.definitionId
    );
  }
  const places = records.unreadableAt;
  const byWorkflow = new Map<string, number>();
  let anyWorkflow = places.unowned;
  for (const [runId, count] of places.runs) {
    const definition = definitions.get(runId);
    if (definition === undefined) {
      anyWorkflow += count;
    } else {
      byWorkflow.set(definition, (byWorkflow.get(definition) ?? 0) + count);
    }
  }
  const unattributedIn = (runId: string) =>
    unattributed.filter((fact) => mayHold(runs.get(runId), fact.completedAt))
      .length;
  return {
    byRun,
    mayBelongTo: (runId) => ({
      unattributed: unattributedIn(runId),
      unreadable: (places.runs.get(runId) ?? 0) + places.unowned,
    }),
    usage: {
      byAgent: groups(
        facts,
        (fact) => fact.agentId,
        (_id, members) => ({
          unattributed:
            unattributed.length -
            members.filter((fact) => fact.scope === "unattributed").length,
          unreadable: records.unreadable,
        })
      ),
      byWorkflow: groups(
        inRuns,
        (fact) => fact.definitionId,
        (id) => ({
          unattributed: unattributed.length,
          unreadable: (byWorkflow.get(id) ?? 0) + anyWorkflow,
        }),
        [
          ...byWorkflow.keys(),
          ...definitions.values(),
          ...(known.workflows ?? []),
        ]
      ),
      outsideRuns: totalOf(
        facts.filter((fact) => fact.scope === "direct"),
        places.direct + places.unowned,
        unattributed.length
      ),
      recovered: records.recovered,
      total: totalOf(facts, records.unreadable),
      unattributed: unattributed.length,
      unreadable: records.unreadable,
      unsaved: records.unsaved,
    },
  };
}
