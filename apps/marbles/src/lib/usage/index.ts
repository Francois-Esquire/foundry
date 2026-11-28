import type {
  LanguageModelV4Middleware,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { AgentModel } from "@foundry/agents/harness";
import type {
  MessageMetadata,
  SessionMessage,
  SessionUsage,
} from "@foundry/agents/session";
import type { ModelCosts, Models } from "@foundry/models";
import { costFromUsage } from "@foundry/models";
import { enrichFromModelsDev } from "@foundry/models/catalog/models-dev";
import { loadedModelsDev } from "@foundry/models/catalog/models-dev-source";
import { claudeCodeCallCost } from "@foundry/models/cost";
import { wrapLanguageModel } from "ai";

import type { UsageStore } from "~/lib/usage/store";
import { usageFactSchema } from "~/lib/usage/store";

export interface UsageTokens {
  readonly cachedInput?: number;
  readonly cacheWrite?: number;
  readonly input: number;
  readonly output: number;
  readonly reasoning?: number;
  readonly total: number;
}

export interface PriceBasis {
  readonly rates: ModelCosts;
  readonly reference: string;
}

export type UsageCost =
  | { readonly kind: "unknown"; readonly reason: string }
  | {
      readonly kind: "reported";
      readonly amount: number;
      readonly currency: string;
      readonly estimate?: true;
      readonly reference: string;
    }
  | {
      readonly kind: "estimated";
      readonly amount: number;
      readonly currency: string;
      readonly pricing: PriceBasis;
    };

interface FactBase {
  readonly agentId: string;
  readonly completedAt: number;
  readonly cost: UsageCost;
  readonly durationMs?: number;
  readonly harness?: string;
  readonly implementation?: string;
  readonly lost?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly sessionId: string;
  readonly tokens?: UsageTokens;
  readonly turnId: string;
  readonly version: 1;
  readonly workspaceId: string;
}

export interface RunUsageFact extends FactBase {
  readonly definitionId: string;
  readonly path: readonly string[];
  readonly runId: string;
  readonly scope: "run";
}

export interface DirectUsageFact extends FactBase {
  readonly scope: "direct";
}

export type RecordedUsageFact = RunUsageFact | DirectUsageFact;

export interface UnattributedUsageFact extends FactBase {
  readonly scope: "unattributed";
}

export type UsageFact = RecordedUsageFact | UnattributedUsageFact;

export type PriceLookup = (
  provider: string,
  model: string
) => PriceBasis | undefined;

export function catalogPrices(models: Models): PriceLookup {
  return (provider, model) => {
    const row = models.providers
      .find((entry) => entry.id === provider)
      ?.models.find((entry) => entry.id === model || entry.modelId === model);
    if (row?.costs) {
      return {
        rates: structuredClone(row.costs),
        reference: `@foundry/models ${provider}/${model}`,
      };
    }
    const catalog = loadedModelsDev();
    if (!(row && catalog)) {
      return;
    }
    const [listed] = enrichFromModelsDev([row], catalog);
    return listed?.costs
      ? {
          rates: structuredClone(listed.costs),
          reference: `models.dev ${provider}/${model}`,
        }
      : undefined;
  };
}

function tokensOf(usage: SessionUsage): UsageTokens | undefined {
  const reported =
    usage.inputTokens > 0 || usage.outputTokens > 0 || usage.totalTokens > 0;
  if (!reported) {
    return;
  }
  return {
    ...(usage.cachedInputTokens
      ? { cachedInput: usage.cachedInputTokens }
      : {}),
    ...(usage.cacheWriteTokens ? { cacheWrite: usage.cacheWriteTokens } : {}),
    input: usage.inputTokens,
    output: usage.outputTokens,
    ...(usage.reasoningTokens ? { reasoning: usage.reasoningTokens } : {}),
    total: usage.totalTokens || usage.inputTokens + usage.outputTokens,
  };
}

export interface ReportedCost {
  readonly amount: number;
  readonly estimate?: true;
  readonly reference: string;
}

export interface CostMeter {
  take(): ReportedCost | undefined;
  wrap(model: AgentModel): AgentModel;
}

export function costMeter(): CostMeter {
  let calls = 0;
  let taken = 0;
  let last: number | undefined;
  const call = () => {
    calls += 1;
    last = undefined;
  };
  const middleware: LanguageModelV4Middleware = {
    specificationVersion: "v4",
    async wrapGenerate({ doGenerate }) {
      call();
      const result = await doGenerate();
      last = claudeCodeCallCost(result.providerMetadata);
      return result;
    },
    async wrapStream({ doStream }) {
      call();
      const result = await doStream();
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream<
            LanguageModelV4StreamPart,
            LanguageModelV4StreamPart
          >({
            transform(part, controller) {
              if (part.type === "finish") {
                last = claudeCodeCallCost(part.providerMetadata);
              }
              controller.enqueue(part);
            },
          })
        ),
      };
    },
  };
  return {
    take: () => {
      const own = calls - taken === 1 ? last : undefined;
      taken = calls;
      return own === undefined
        ? undefined
        : { amount: own, estimate: true, reference: CLAUDE_CODE_REPORTED };
    },
    wrap: (model) =>
      Object.assign(wrapLanguageModel({ middleware, model }), {
        ...(model.limits ? { limits: model.limits } : {}),
        ...(model.route ? { route: model.route } : {}),
      }),
  };
}

const CLAUDE_CODE_REPORTED = "claude-code total_cost_usd";

function costOf(
  tokens: UsageTokens | undefined,
  route: { readonly model?: string; readonly provider?: string },
  price: PriceLookup,
  reported: ReportedCost | undefined
): UsageCost {
  if (reported) {
    return {
      amount: reported.amount,
      currency: "USD",
      kind: "reported",
      ...(reported.estimate ? { estimate: true } : {}),
      reference: reported.reference,
    };
  }
  if (!tokens) {
    return { kind: "unknown", reason: "the harness reported no token usage" };
  }
  if (route.provider === undefined || route.model === undefined) {
    return { kind: "unknown", reason: "the turn did not report its model" };
  }
  const basis = price(route.provider, route.model);
  if (!basis) {
    return {
      kind: "unknown",
      reason: `no list price for ${route.provider}/${route.model}`,
    };
  }
  const { total } = costFromUsage(basis.rates, {
    cacheReadTokens: tokens.cachedInput ?? 0,
    cacheWriteTokens: tokens.cacheWrite ?? 0,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
  });
  return { amount: total, currency: "USD", kind: "estimated", pricing: basis };
}

export interface TurnSource {
  readonly agentId: string;
  readonly run?: {
    readonly definition: string;
    readonly path: readonly string[];
    readonly runId: string;
  };
}

function scopeOf(
  source: TurnSource
):
  | Pick<RunUsageFact, "definitionId" | "path" | "runId" | "scope">
  | Pick<DirectUsageFact, "scope"> {
  const { run } = source;
  return run
    ? {
        definitionId: run.definition,
        path: [...run.path],
        runId: run.runId,
        scope: "run",
      }
    : { scope: "direct" };
}

export function usageFact(
  turn: {
    readonly message: SessionMessage;
    readonly reported?: ReportedCost;
    readonly route: {
      readonly implementation?: string;
      readonly model?: string;
      readonly provider?: string;
    };
    readonly source: TurnSource;
    readonly usage?: SessionUsage;
    readonly workspaceId: string;
  },
  price: PriceLookup
): RecordedUsageFact {
  const { message, source } = turn;
  const reported = message.metadata?.model;
  const route = {
    model: reported?.id ?? turn.route.model,
    provider: reported?.provider ?? turn.route.provider,
  };
  const usage = message.metadata?.usage ?? turn.usage;
  const tokens = usage ? tokensOf(usage) : undefined;
  const timing = message.metadata?.timing;
  return {
    agentId: source.agentId,
    completedAt: timing?.completedAt ?? message.updatedAt,
    cost: costOf(tokens, route, price, turn.reported),
    ...(timing ? { durationMs: timing.durationMs } : {}),
    ...(turn.route.implementation === undefined
      ? {}
      : { implementation: turn.route.implementation }),
    ...(route.model === undefined ? {} : { model: route.model }),
    ...(route.provider === undefined ? {} : { provider: route.provider }),
    ...scopeOf(source),
    sessionId: message.sessionId,
    ...(tokens ? { tokens } : {}),
    turnId: message.id,
    version: 1,
    workspaceId: turn.workspaceId,
  };
}

export function lostFact(
  turn: {
    readonly completedAt: number;
    readonly sessionId: string;
    readonly source: TurnSource;
    readonly turnId: string;
    readonly workspaceId: string;
  },
  reason: string
): RecordedUsageFact {
  return {
    agentId: turn.source.agentId,
    completedAt: turn.completedAt,
    cost: { kind: "unknown", reason: `usage was not saved: ${reason}` },
    lost: reason,
    ...scopeOf(turn.source),
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    version: 1,
    workspaceId: turn.workspaceId,
  };
}

export const RECOVERED =
  "not recorded; tokens recovered from the session transcript";

export interface TranscriptTurn {
  readonly id: string;
  readonly metadata?: Pick<MessageMetadata, "model" | "timing" | "usage">;
  readonly sessionId: string;
  readonly updatedAt: number;
}

export function recoveredFact(turn: {
  readonly agentId: string;
  readonly message: TranscriptTurn;
  readonly source?: TurnSource;
  readonly workspaceId: string;
}): UsageFact {
  const { message } = turn;
  const route = message.metadata?.model;
  const usage = message.metadata?.usage;
  const tokens = usage ? tokensOf(usage) : undefined;
  const timing = message.metadata?.timing;
  return {
    agentId: turn.source?.agentId ?? turn.agentId,
    completedAt: timing?.completedAt ?? message.updatedAt,
    cost: { kind: "unknown", reason: `usage was ${RECOVERED}` },
    ...(timing ? { durationMs: timing.durationMs } : {}),
    lost: RECOVERED,
    ...(route?.id ? { model: route.id } : {}),
    ...(route?.provider ? { provider: route.provider } : {}),
    ...(turn.source ? scopeOf(turn.source) : { scope: "unattributed" }),
    sessionId: message.sessionId,
    ...(tokens ? { tokens } : {}),
    turnId: message.id,
    version: 1,
    workspaceId: turn.workspaceId,
  };
}

export function sourceOf(fact: RecordedUsageFact): TurnSource {
  return fact.scope === "run"
    ? {
        agentId: fact.agentId,
        run: {
          definition: fact.definitionId,
          path: fact.path,
          runId: fact.runId,
        },
      }
    : { agentId: fact.agentId };
}

export interface UsageRecords {
  readonly facts: readonly UsageFact[];
  readonly recovered: number;
  readonly unreadable: number;
  readonly unreadableAt: UnreadablePlaces;
  readonly unsaved: number;
  readonly unsavedTurns: ReadonlySet<string>;
}

export interface UnreadablePlaces {
  readonly direct: number;
  readonly runs: ReadonlyMap<string, number>;
  readonly unowned: number;
}

export function withRecovered(
  records: UsageRecords,
  { facts: recovered, unreadable }: Reconciled
): UsageRecords {
  const unverified =
    unreadable.unowned +
    [...unreadable.runs.values()].reduce((sum, value) => sum + value, 0);
  if (recovered.length === 0 && unverified === 0) {
    return records;
  }
  const runs = new Map(records.unreadableAt.runs);
  for (const [runId, value] of unreadable.runs) {
    runs.set(runId, (runs.get(runId) ?? 0) + value);
  }
  const byTurn = new Map(records.facts.map((fact) => [fact.turnId, fact]));
  const replaced = new Set<string>();
  let added = 0;
  for (const fact of recovered) {
    const known = byTurn.get(fact.turnId);
    if (known && known.lost === undefined) {
      continue;
    }
    if (known) {
      replaced.add(fact.turnId);
    }
    byTurn.set(fact.turnId, fact);
    added += 1;
  }
  const unsavedTurns = new Set(
    [...records.unsavedTurns].filter((turnId) => !replaced.has(turnId))
  );
  return {
    ...records,
    facts: [...byTurn.values()],
    recovered: records.recovered + added,
    unreadable: records.unreadable + unverified,
    unreadableAt: {
      direct: records.unreadableAt.direct,
      runs,
      unowned: records.unreadableAt.unowned + unreadable.unowned,
    },
    unsaved: unsavedTurns.size,
    unsavedTurns,
  };
}

export interface Reconciled {
  readonly facts: readonly UsageFact[];
  readonly unreadable: Omit<UnreadablePlaces, "direct">;
}

export type RecordOutcome =
  | { readonly saved: "fact" }
  | { readonly saved: "marker"; readonly error: string }
  | { readonly saved: "nothing"; readonly error: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class UsageLedger {
  readonly #store: UsageStore;
  readonly #unsaved = new Map<string, RecordedUsageFact>();
  #cache:
    | {
        readonly revision: number;
        readonly unsaved: number;
        readonly records: UsageRecords;
      }
    | undefined;

  constructor(store: UsageStore) {
    this.#store = store;
  }

  async record(fact: RecordedUsageFact): Promise<RecordOutcome> {
    try {
      await (fact.lost === undefined
        ? this.#store.save(fact)
        : this.#store.mark(fact));
      this.#unsaved.delete(fact.turnId);
      return { saved: "fact" };
    } catch (error) {
      return await this.#lose(fact, errorText(error));
    }
  }

  async #lose(fact: RecordedUsageFact, error: string): Promise<RecordOutcome> {
    const marker = lostFact(
      {
        completedAt: fact.completedAt,
        sessionId: fact.sessionId,
        source: sourceOf(fact),
        turnId: fact.turnId,
        workspaceId: fact.workspaceId,
      },
      error
    );
    try {
      await this.#store.mark(marker);
      this.#unsaved.delete(marker.turnId);
      return { error, saved: "marker" };
    } catch (markerError) {
      this.#unsaved.set(marker.turnId, marker);
      return {
        error: `${error}; marker: ${errorText(markerError)}`,
        saved: "nothing",
      };
    }
  }

  async read(): Promise<UsageRecords> {
    const revision = await this.#store.revision();
    if (
      this.#cache?.revision === revision &&
      this.#cache.unsaved === this.#unsaved.size
    ) {
      return this.#cache.records;
    }
    const stored = await this.#store.facts();
    const byTurn = new Map<string, RecordedUsageFact>();
    const places = { direct: 0, runs: new Map<string, number>(), unowned: 0 };
    let unreadable = 0;
    for (const { owner, value } of stored.facts) {
      const parsed = usageFactSchema.safeParse(value);
      if (!parsed.success) {
        unreadable += 1;
        if (owner.kind === "run") {
          places.runs.set(owner.runId, (places.runs.get(owner.runId) ?? 0) + 1);
        } else {
          places.direct += 1;
        }
        continue;
      }
      const fact = parsed.data as RecordedUsageFact;
      byTurn.set(fact.turnId, fact);
    }
    const unsavedTurns = new Set<string>();
    for (const marker of this.#unsaved.values()) {
      if (!byTurn.has(marker.turnId)) {
        byTurn.set(marker.turnId, marker);
        unsavedTurns.add(marker.turnId);
      }
    }
    const records: UsageRecords = {
      facts: [...byTurn.values()],
      recovered: 0,
      unreadable,
      unreadableAt: places,
      unsaved: unsavedTurns.size,
      unsavedTurns,
    };
    this.#cache = {
      records,
      revision: stored.revision,
      unsaved: this.#unsaved.size,
    };
    return records;
  }
}
