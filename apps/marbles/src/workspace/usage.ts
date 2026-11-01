import type { RunUsageFact, UsageFact, UsageRecords } from "~/lib/usage";
import type {
  Money,
  StepUsage,
  UsageGroup,
  UsageTotal,
  WorkspaceUsage,
} from "~/model/usage";

/**
 * Totals from usage facts. Each fact is one turn's own consumption, so any
 * total is the sum of the facts it covers: a step's inclusive total takes
 * its descendants' facts directly, never their totals.
 */

function addMoney(sums: Map<string, number>, money: Money): void {
  sums.set(money.currency, (sums.get(money.currency) ?? 0) + money.amount);
}

function moneyOf(sums: ReadonlyMap<string, number>): Money[] {
  return [...sums]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amount]) => ({ amount, currency }));
}

/**
 * The sum of `facts`. `unreadable` is how many records that could not be
 * read may belong here, and `unattributed` how many recovered turns not
 * among `facts` may: the total says it is incomplete while either is above
 * zero, even with no facts at all.
 */
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
    // A lost leaf adds what tokens it knows (a recovered one does), never a cost.
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
    } else if (cost.kind === "estimated") {
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

/** What may belong to a total besides its own facts. */
export interface MayBelong {
  readonly unattributed: number;
  readonly unreadable: number;
}

const NOTHING: MayBelong = { unattributed: 0, unreadable: 0 };

/** A run's facts under one path segment: its own, and its children's by segment. */
interface StepFacts {
  readonly children: Map<string, StepFacts>;
  readonly direct: RunUsageFact[];
}

function factsBelow(node: StepFacts): RunUsageFact[] {
  return [...node.direct, ...[...node.children.values()].flatMap(factsBelow)];
}

/**
 * Each step's usage in one run, indexed once: a step's own facts and every
 * descendant's, matched on whole path segments, so a step named `a.b` is
 * neither `a`'s child `b` nor part of a sibling `a`. What `mayBelong` to the
 * run may belong to any of its steps, so both totals carry it; a step with
 * neither facts nor such records has no usage.
 */
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

/**
 * Totals by `key`, and a group for each of `others` that only records not
 * among the facts may belong to; a group with neither is left out.
 */
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

/** A run the host knows: its workflow, and when it was running. */
export interface KnownRun {
  readonly createdAt: number;
  readonly definition: string;
  readonly endedAt?: number;
}

/** Whether a turn that finished `at` can be `run`'s; a run whose times are not known may hold any. */
function mayHold(run: KnownRun | undefined, at: number): boolean {
  return (
    run === undefined ||
    (at >= run.createdAt && (run.endedAt === undefined || at <= run.endedAt))
  );
}

/**
 * This workspace's run facts by run, and its totals: every turn by agent,
 * run turns by workflow, and turns outside any run on their own.
 *
 * Unreadable records go where their usage document's key, or the run whose
 * own file it is, filed them, never by their own fields: a run's to that
 * run and its workflow, a direct session's to turns outside runs, and
 * records with no owner, unreadable transcripts among them, to every run
 * and workflow. Any of them
 * may be any agent's. An unattributed turn counts in the workspace total
 * and its agent's, and may belong to the turns outside runs, any other
 * agent, any run running when it finished, and every workflow. A loaded
 * run's window clears only that run: a run this reader cannot load (one
 * still running in another process) may be any workflow's, so no workflow
 * is cleared by the runs it has.
 *
 * `known.runs` names each known run's workflow and times, so a run's
 * unreadable records reach its workflow even when none of its facts
 * survived; `known.workflows` are the definitions shown, each of which gets
 * a total when unowned records may belong to it.
 */
export function workspaceUsage(
  records: UsageRecords,
  workspaceId: string | undefined,
  known: {
    readonly runs?: ReadonlyMap<string, KnownRun>;
    readonly workflows?: Iterable<string>;
  } = {}
): {
  readonly byRun: ReadonlyMap<string, readonly RunUsageFact[]>;
  /** What may belong to a run besides its facts. */
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
  // A run's records whose workflow is not known may be any workflow's.
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
