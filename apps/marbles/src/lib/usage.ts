import type { SessionMessage, SessionUsage } from "@foundry/agents/session";
import type { ModelCosts, ModelManager } from "@foundry/models";
import { costFromUsage } from "@foundry/models";

import { isRecord } from "~/lib/state/json";
import type { StateStore } from "~/lib/state/store";

/**
 * What agent turns consumed, recorded once per committed turn. A fact is a
 * leaf: the turn's own tokens and its own cost, never a total. Run, step,
 * workflow and agent totals are sums of facts, so a parent's figure is never
 * added to its children's. The committed message's id is the turn's identity:
 * a streamed finish, a final result and a later read of the same turn all
 * name one message, and a replayed `generate` returns the recorded message
 * without running a turn, so none of them records twice. A retry or a body
 * that runs a turn again commits a new message: that is new consumption.
 *
 * A turn inside a run is attributed to the run, its root definition and the
 * step it ran in. A turn in a session opened outside any run (a host calling
 * `engine.agents.session` or a definition's own `generate`) is a `direct`
 * fact: its agent and session, and no run or workflow. Native subagents a
 * CLI harness starts inside a turn are not separate facts: whatever the
 * harness reports for its turn is what the turn consumed.
 *
 * A turn whose fact could not be saved leaves a `lost` marker instead, so a
 * total over the turns that were saved says it is incomplete. A turn found
 * later in a transcript with neither is recovered, and is `unattributed`
 * when nothing durable says which run, or no run, it ran in.
 */

/** Token counts as the turn reported them. `input` is gross: it includes the cache reads and writes. */
export interface UsageTokens {
  readonly cachedInput?: number;
  readonly cacheWrite?: number;
  readonly input: number;
  readonly output: number;
  /** The part of `output` spent reasoning; not added to it again. */
  readonly reasoning?: number;
  readonly total: number;
}

/** The list price a turn was estimated at, kept with the fact so later price changes do not rewrite it. */
export interface PriceBasis {
  /** USD per million tokens, copied from the catalog when the turn finished. */
  readonly rates: ModelCosts;
  /** Which catalog row: `@foundry/models <provider>/<model>`. */
  readonly reference: string;
}

/**
 * What a turn cost. `reported` is a provider's own figure; `estimated` is
 * tokens at a list price; `unknown` is neither, and is never read as zero.
 */
export type UsageCost =
  | { readonly kind: "unknown"; readonly reason: string }
  | {
      readonly kind: "reported";
      readonly amount: number;
      readonly currency: string;
      readonly reference: string;
    }
  | {
      readonly kind: "estimated";
      readonly amount: number;
      readonly currency: string;
      readonly pricing: PriceBasis;
    };

/** What every fact carries, wherever its turn ran. */
interface FactBase {
  readonly agentId: string;
  readonly completedAt: number;
  readonly cost: UsageCost;
  readonly durationMs?: number;
  readonly harness?: string;
  /**
   * Why this turn's usage was not saved: the fact is a marker of a turn that
   * ran, with no tokens and an unknown cost.
   */
  readonly lost?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly sessionId: string;
  /** Absent when the harness reported no token counts at all. */
  readonly tokens?: UsageTokens;
  /** The committed message's id. */
  readonly turnId: string;
  readonly version: 1;
  readonly workspaceId: string;
}

/** A turn in a step of a run. */
export interface RunUsageFact extends FactBase {
  /** The run's root definition: what a workflow total groups by. */
  readonly definitionId: string;
  /** The frame the turn ran in, from the run's root down; joined with `.` it is the step id. */
  readonly path: readonly string[];
  readonly runId: string;
  readonly scope: "run";
}

/** A turn in a session opened outside any run: no run, step or workflow to attribute. */
export interface DirectUsageFact extends FactBase {
  readonly scope: "direct";
}

/** What the ledger records: every turn it is told about ran in a run or outside one. */
export type RecordedUsageFact = RunUsageFact | DirectUsageFact;

/**
 * A recovered turn whose owner nothing durable proves: no marker or
 * one-turn call names it, in a session a run opened or continued, or one no
 * saved fact or run file names. It counts in the workspace's total, and may
 * belong to any run that was running when it finished or to the turns
 * outside runs. Never saved.
 */
export interface UnattributedUsageFact extends FactBase {
  readonly scope: "unattributed";
}

export type UsageFact = RecordedUsageFact | UnattributedUsageFact;

/** A model's list price, when the catalog has one. */
export type PriceLookup = (
  provider: string,
  model: string
) => PriceBasis | undefined;

/** List prices from the routes the engine's models registered; pricing stays in `@foundry/models`. */
export function catalogPrices(models: ModelManager): PriceLookup {
  return (provider, model) => {
    if (!models.has(provider)) {
      return;
    }
    const row = models
      .get(provider)
      .models.find((entry) => entry.id === model || entry.modelId === model);
    return row?.costs
      ? {
          rates: structuredClone(row.costs),
          reference: `@foundry/models ${provider}/${model}`,
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

function costOf(
  tokens: UsageTokens | undefined,
  route: { readonly model?: string; readonly provider?: string },
  price: PriceLookup
): UsageCost {
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
  // Reasoning is inside output, so it is not passed to be billed again.
  const { total } = costFromUsage(basis.rates, {
    cacheReadTokens: tokens.cachedInput ?? 0,
    cacheWriteTokens: tokens.cacheWrite ?? 0,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
  });
  return { amount: total, currency: "USD", kind: "estimated", pricing: basis };
}

/** Where a turn ran, as the agents manager knows it: the run is absent outside one. */
export interface TurnSource {
  readonly agentId: string;
  readonly run?: {
    readonly definition: string;
    readonly path: readonly string[];
    readonly runId: string;
  };
}

/** The run attribution a fact carries, or `direct`. */
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

/** One committed turn as a fact, priced from the catalog when it lists the model. */
export function usageFact(
  turn: {
    readonly message: SessionMessage;
    readonly route: { readonly model?: string; readonly provider?: string };
    readonly source: TurnSource;
    /** What the turn's stream reported, when the message carries no usage of its own. */
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
    cost: costOf(tokens, route, price),
    ...(timing ? { durationMs: timing.durationMs } : {}),
    ...(reported?.harness ? { harness: reported.harness } : {}),
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

/**
 * A turn that ran but whose usage could not be turned into a fact or saved:
 * its identity and attribution, no tokens, an unknown cost, and why.
 */
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

/** Why a recovered leaf has no price: what it is, said once. */
export const RECOVERED =
  "not recorded; tokens recovered from the session transcript";

/**
 * A committed turn found in a transcript with no saved fact: the tokens and
 * route its message carries, an unknown cost (the list price it ran at is
 * not known now), and `lost`, so totals over it say they are incomplete.
 * Without a `source` it is `unattributed`, under `agentId`.
 */
export function recoveredFact(turn: {
  readonly agentId: string;
  readonly message: SessionMessage;
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
    ...(route?.harness ? { harness: route.harness } : {}),
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

/** Where a recorded fact, or a `lost` marker, says its turn ran. */
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

const COLLECTION = "usage";

/*
 * Reading back: state is advisory, so a document or fact that does not have
 * every field the totals and labels use, with the right type, is counted as
 * unreadable rather than trusted or read as zero.
 */

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function optionalText(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function optionalCount(value: unknown): value is number | undefined {
  return value === undefined || count(value);
}

function decodeTokens(value: unknown): UsageTokens | undefined {
  if (
    !(
      isRecord(value) &&
      count(value.input) &&
      count(value.output) &&
      count(value.total) &&
      optionalCount(value.cachedInput) &&
      optionalCount(value.cacheWrite) &&
      optionalCount(value.reasoning)
    )
  ) {
    return;
  }
  return {
    ...(value.cachedInput === undefined
      ? {}
      : { cachedInput: value.cachedInput }),
    ...(value.cacheWrite === undefined ? {} : { cacheWrite: value.cacheWrite }),
    input: value.input,
    output: value.output,
    ...(value.reasoning === undefined ? {} : { reasoning: value.reasoning }),
    total: value.total,
  };
}

function isTiers(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (tier) =>
          isRecord(tier) &&
          count(tier.costPer1M) &&
          count(tier.minTokens) &&
          optionalCount(tier.maxTokens)
      ))
  );
}

function decodePricing(value: unknown): PriceBasis | undefined {
  if (!(isRecord(value) && text(value.reference) && isRecord(value.rates))) {
    return;
  }
  const { rates } = value;
  const valid =
    count(rates.input) &&
    count(rates.output) &&
    optionalCount(rates.cachedInput) &&
    optionalCount(rates.cacheWrite) &&
    isTiers(rates.inputTiers) &&
    isTiers(rates.outputTiers);
  // Kept as recorded: provenance, validated, never re-priced.
  return valid
    ? { rates: rates as unknown as ModelCosts, reference: value.reference }
    : undefined;
}

function decodeCost(value: unknown): UsageCost | undefined {
  if (!isRecord(value)) {
    return;
  }
  if (value.kind === "unknown") {
    return typeof value.reason === "string"
      ? { kind: "unknown", reason: value.reason }
      : undefined;
  }
  if (!(count(value.amount) && text(value.currency))) {
    return;
  }
  if (value.kind === "reported") {
    return text(value.reference)
      ? {
          amount: value.amount,
          currency: value.currency,
          kind: "reported",
          reference: value.reference,
        }
      : undefined;
  }
  if (value.kind === "estimated") {
    const pricing = decodePricing(value.pricing);
    return pricing
      ? {
          amount: value.amount,
          currency: value.currency,
          kind: "estimated",
          pricing,
        }
      : undefined;
  }
}

function decodeScope(
  value: Record<string, unknown>
):
  | Pick<RunUsageFact, "definitionId" | "path" | "runId" | "scope">
  | Pick<DirectUsageFact, "scope">
  | undefined {
  if (value.scope === "direct") {
    return { scope: "direct" };
  }
  const { path } = value;
  if (
    value.scope === "run" &&
    text(value.runId) &&
    text(value.definitionId) &&
    Array.isArray(path) &&
    path.every(text)
  ) {
    return {
      definitionId: value.definitionId,
      path: [...path],
      runId: value.runId,
      scope: "run",
    };
  }
}

/** A persisted fact, rebuilt from the fields it must have; `undefined` when any is missing or wrong. */
function decodeFact(value: unknown): RecordedUsageFact | undefined {
  if (
    !(
      isRecord(value) &&
      value.version === 1 &&
      text(value.turnId) &&
      text(value.sessionId) &&
      text(value.workspaceId) &&
      text(value.agentId) &&
      count(value.completedAt) &&
      optionalCount(value.durationMs) &&
      optionalText(value.harness) &&
      optionalText(value.model) &&
      optionalText(value.provider) &&
      optionalText(value.lost)
    )
  ) {
    return;
  }
  const scope = decodeScope(value);
  const cost = decodeCost(value.cost);
  const tokens =
    value.tokens === undefined ? undefined : decodeTokens(value.tokens);
  if (!(scope && cost) || (value.tokens !== undefined && !tokens)) {
    return;
  }
  return {
    agentId: value.agentId,
    completedAt: value.completedAt,
    cost,
    ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs }),
    ...(value.harness === undefined ? {} : { harness: value.harness }),
    ...(value.lost === undefined ? {} : { lost: value.lost }),
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.provider === undefined ? {} : { provider: value.provider }),
    ...scope,
    sessionId: value.sessionId,
    ...(tokens ? { tokens } : {}),
    turnId: value.turnId,
    version: 1,
    workspaceId: value.workspaceId,
  };
}

/** What the ledger holds, and what it could not read or save. */
export interface UsageRecords {
  readonly facts: readonly UsageFact[];
  /**
   * Turns found in a run's or direct session's transcript with no saved
   * fact: among `facts` as `lost` leaves with the transcript's tokens.
   */
  readonly recovered: number;
  /**
   * Documents or facts that could not be read, and transcripts or run files
   * that reconciliation needed and could not read: totals over them are
   * partial.
   */
  readonly unreadable: number;
  /**
   * Where unreadable records were filed: a usage document by its key, by
   * run or outside runs; a settled run's file by that run; anything else,
   * transcripts included, nowhere (`unowned`). The counts add up to
   * `unreadable`. A record's own fields are not trusted for this.
   */
  readonly unreadableAt: UnreadablePlaces;
  /**
   * Turns whose usage, and whose `lost` marker, could not be saved, and that
   * no transcript accounted for: among `facts` only for this process.
   */
  readonly unsaved: number;
  /** The turn ids `unsaved` counts. */
  readonly unsavedTurns: ReadonlySet<string>;
}

/**
 * Unreadable records by where their document said they belong: a usage
 * document by its key, a settled run's file by its run. Who named a
 * transcript does not own it: any run, or the host, may have continued it.
 */
export interface UnreadablePlaces {
  /** Filed under a direct session's usage document. */
  readonly direct: number;
  /** Filed under a run's usage document, or the run's own file, by run id. */
  readonly runs: ReadonlyMap<string, number>;
  /** A key that names no owner, a transcript, or a session listing that failed. */
  readonly unowned: number;
}

const RUN_KEY = /^run\.([^+]+)(?:\+.*)?$/;
const DIRECT_KEY = /^direct\.[^+]+(?:\+.*)?$/;

/** Count one unreadable record where its document key says it belongs. */
function placeUnreadable(
  places: { direct: number; runs: Map<string, number>; unowned: number },
  key: string
): void {
  const run = RUN_KEY.exec(key)?.[1];
  if (run !== undefined) {
    try {
      const id = decodeURIComponent(run);
      places.runs.set(id, (places.runs.get(id) ?? 0) + 1);
      return;
    } catch {
      // Not an encoding the ledger wrote: owner unknown.
    }
  }
  if (DIRECT_KEY.test(key)) {
    places.direct += 1;
    return;
  }
  places.unowned += 1;
}

/**
 * Records with what reconciliation found merged in: a recovered leaf
 * replaces a `lost` marker for the same turn (it knows the tokens), and
 * never a saved fact; evidence it could not read adds to `unreadable`.
 */
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
  // A recovered leaf accounts for an in-memory marker of the same turn.
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

/** What reconciliation found: recovered leaves, and the evidence it could not read, by owner. */
export interface Reconciled {
  readonly facts: readonly UsageFact[];
  /** No transcript or run file is a direct session's usage document. */
  readonly unreadable: Omit<UnreadablePlaces, "direct">;
}

/** How a `record` went: the fact saved, a `lost` marker saved instead, or neither. */
export type RecordOutcome =
  | { readonly saved: "fact" }
  | { readonly saved: "marker"; readonly error: string }
  | { readonly saved: "nothing"; readonly error: string };

/** Keys are file names: one document per run, or per direct session. */
function documentKey(fact: RecordedUsageFact): string {
  return fact.scope === "run"
    ? `run.${encodeURIComponent(fact.runId)}`
    : `direct.${encodeURIComponent(fact.sessionId)}`;
}

/** A one-fact document beside its own, for a fact its document cannot take. */
function sideKey(key: string, turnId: string): string {
  return `${key}+${encodeURIComponent(turnId)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Usage facts in the engine's state store: one document per run (or per
 * direct session) holding its facts by turn id, so recording a turn again
 * replaces it instead of adding to it. A document that cannot be read is
 * never overwritten; a fact for it goes into a document of its own. Writes
 * are synchronous read-modify-write: a run's turns all record in the process
 * that runs it. Reads are cached until the collection or the unsaved markers
 * change, for a dashboard that polls.
 */
export class UsageLedger {
  readonly #store: StateStore;
  /** `lost` markers that could not be saved either, by turn id. */
  readonly #unsaved = new Map<string, RecordedUsageFact>();
  #cache:
    | {
        readonly revision: string;
        readonly unsaved: number;
        readonly records: UsageRecords;
        readonly unreadableKeys: ReadonlySet<string>;
      }
    | undefined;

  constructor(store: StateStore) {
    this.#store = store;
  }

  /**
   * Save a fact. When that fails, save a `lost` marker for the turn, and
   * when that fails too, keep the marker in memory. Never throws.
   */
  record(fact: RecordedUsageFact): RecordOutcome {
    try {
      this.#save(fact);
      this.#unsaved.delete(fact.turnId);
      return { saved: "fact" };
    } catch (error) {
      return this.#lose(fact, errorText(error));
    }
  }

  #lose(fact: RecordedUsageFact, error: string): RecordOutcome {
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
      this.#store.write(
        COLLECTION,
        sideKey(documentKey(marker), marker.turnId),
        { facts: { [marker.turnId]: marker }, version: 1 }
      );
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

  #save(fact: RecordedUsageFact): void {
    const key = documentKey(fact);
    const existing = this.#store.read(COLLECTION, key);
    const readable = isRecord(existing) && isRecord(existing.facts);
    if (
      !readable &&
      (existing !== undefined || this.#unreadableKeys().has(key))
    ) {
      // Something is there that cannot be read: leave it for a person.
      this.#store.write(COLLECTION, sideKey(key, fact.turnId), {
        facts: { [fact.turnId]: fact },
        version: 1,
      });
      return;
    }
    const facts = readable ? (existing.facts as Record<string, unknown>) : {};
    this.#store.write(COLLECTION, key, {
      facts: { ...facts, [fact.turnId]: fact },
      version: 1,
    });
  }

  #unreadableKeys(): ReadonlySet<string> {
    this.read();
    return this.#cache?.unreadableKeys ?? new Set();
  }

  read(): UsageRecords {
    const revision = this.#store.revision(COLLECTION);
    if (
      this.#cache?.revision === revision &&
      this.#cache.unsaved === this.#unsaved.size
    ) {
      return this.#cache.records;
    }
    const byTurn = new Map<string, RecordedUsageFact>();
    const unreadableKeys = new Set<string>();
    const places = { direct: 0, runs: new Map<string, number>(), unowned: 0 };
    let unreadable = 0;
    for (const document of this.#store.list(COLLECTION)) {
      const { value } = document;
      if (!(isRecord(value) && isRecord(value.facts))) {
        unreadable += 1;
        unreadableKeys.add(document.key);
        placeUnreadable(places, document.key);
        continue;
      }
      for (const stored of Object.values(value.facts)) {
        const fact = decodeFact(stored);
        if (!fact) {
          unreadable += 1;
          placeUnreadable(places, document.key);
          continue;
        }
        // A saved fact outranks a marker for the same turn.
        const known = byTurn.get(fact.turnId);
        if (!known || (known.lost !== undefined && fact.lost === undefined)) {
          byTurn.set(fact.turnId, fact);
        }
      }
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
      revision,
      unreadableKeys,
      unsaved: this.#unsaved.size,
    };
    return records;
  }
}
