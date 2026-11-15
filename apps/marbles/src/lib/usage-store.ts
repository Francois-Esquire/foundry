import { z } from "zod";

import { RecordsGate } from "~/lib/events/records";
import { storableJson } from "~/lib/state/json";
import type { RecordedUsageFact } from "~/lib/usage";

/**
 * Where a workspace's usage facts are kept: one per turn, by the turn's
 * id, so recording a turn again replaces it. The ledger (`UsageLedger` in
 * `lib/usage.ts`) says which write a fact gets; the store keeps what it is
 * told. `MemoryUsageStore` keeps facts in this process; the Marbles
 * database keeps them on disk (`database/usage.ts`), shared by every
 * engine over it.
 */
export interface UsageStore {
  /** Refuse every call from now on, once those under way have settled. */
  close(): Promise<void>;
  /**
   * Every fact kept, each as it was stored and filed, and the revision
   * they were read at. A stored value is not trusted: the ledger reads it
   * through `usageFactSchema`.
   */
  facts(): Promise<{
    readonly facts: readonly StoredUsage[];
    readonly revision: number;
  }>;
  /**
   * Keep `marker`, a `lost` marker, as its turn's, unless the turn already
   * has a fact or a marker: a saved fact is never replaced by one.
   */
  mark(marker: RecordedUsageFact): Promise<void>;
  /**
   * Grows with every fact kept, by any engine sharing the store, so a
   * reader skips reading the facts while it holds. Facts are never
   * removed.
   */
  revision(): Promise<number>;
  /** Keep `fact` as its turn's, replacing whatever the turn had. */
  save(fact: RecordedUsageFact): Promise<void>;
}

/** Where a stored fact was filed, read from the store, never from the fact. */
export type UsageOwner =
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "direct" };

/** A fact as the store gives it back: filed under its owner, its value unchecked. */
export interface StoredUsage {
  readonly owner: UsageOwner;
  readonly value: unknown;
}

/**
 * The copy of a usage fact every store keeps: plain JSON as it reads back
 * (`storableJson`), so a fact reads back the same from memory as from the
 * database. One JSON would not give back as it is is refused with a
 * `NotStorableError` naming the part.
 */
export function storedUsageFact(fact: RecordedUsageFact): RecordedUsageFact {
  return storableJson(
    `usage fact for turn ${JSON.stringify(fact.turnId)}`,
    fact
  ) as unknown as RecordedUsageFact;
}

/** The owner a fact is filed under. */
export function ownerOf(fact: RecordedUsageFact): UsageOwner {
  return fact.scope === "run"
    ? { kind: "run", runId: fact.runId }
    : { kind: "direct" };
}

/** A non-empty string. */
const text = z.string().min(1);
/** A finite count, never negative. */
const count = z.number().finite().min(0);

const tokens = z.object({
  cachedInput: count.optional(),
  cacheWrite: count.optional(),
  input: count,
  output: count,
  reasoning: count.optional(),
  total: count,
});

const tier = z.looseObject({
  costPer1M: count,
  maxTokens: count.optional(),
  minTokens: count,
});

/** List rates, kept whole as recorded: provenance, never re-priced. */
const rates = z.looseObject({
  cachedInput: count.optional(),
  cacheWrite: count.optional(),
  input: count,
  inputTiers: z.array(tier).optional(),
  output: count,
  outputTiers: z.array(tier).optional(),
});

const cost = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unknown"), reason: z.string() }),
  z.object({
    amount: count,
    currency: text,
    estimate: z.literal(true).optional(),
    kind: z.literal("reported"),
    reference: text,
  }),
  z.object({
    amount: count,
    currency: text,
    kind: z.literal("estimated"),
    pricing: z.object({ rates, reference: text }),
  }),
]);

const base = z.object({
  agentId: text,
  completedAt: count,
  cost,
  durationMs: count.optional(),
  harness: z.string().optional(),
  implementation: z.string().optional(),
  lost: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  sessionId: text,
  tokens: tokens.optional(),
  turnId: text,
  version: z.literal(1),
  workspaceId: text,
});

/**
 * A stored fact, with every field the totals and labels use, of the right
 * type: one that is not is counted unreadable rather than trusted or read
 * as zero.
 */
export const usageFactSchema = z.discriminatedUnion("scope", [
  base.extend({
    definitionId: text,
    path: z.array(text),
    runId: text,
    scope: z.literal("run"),
  }),
  base.extend({ scope: z.literal("direct") }),
]);

/**
 * The usage store held in this process, for one engine: nothing outlives
 * it. Facts are copied in and out, so no caller shares a reference with
 * the store.
 */
export class MemoryUsageStore implements UsageStore {
  readonly #gate = new RecordsGate("the usage store is closed");
  readonly #facts = new Map<string, StoredUsage>();
  #revision = 0;

  close(): Promise<void> {
    return this.#gate.close();
  }

  facts(): Promise<{
    readonly facts: readonly StoredUsage[];
    readonly revision: number;
  }> {
    return this.#gate.run(() =>
      Promise.resolve({
        facts: structuredClone([...this.#facts.values()]),
        revision: this.#revision,
      })
    );
  }

  mark(marker: RecordedUsageFact): Promise<void> {
    return this.#gate.run(async () => {
      const stored = storedUsageFact(marker);
      if (!this.#facts.has(stored.turnId)) {
        this.#keep(stored);
      }
    });
  }

  revision(): Promise<number> {
    return this.#gate.run(() => Promise.resolve(this.#revision));
  }

  save(fact: RecordedUsageFact): Promise<void> {
    return this.#gate.run(async () => {
      this.#keep(storedUsageFact(fact));
    });
  }

  /** Keep `fact`, already in its stored form. */
  #keep(fact: RecordedUsageFact): void {
    this.#facts.set(fact.turnId, { owner: ownerOf(fact), value: fact });
    this.#revision += 1;
  }
}
