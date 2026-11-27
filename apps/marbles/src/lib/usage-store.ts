import { z } from "zod";

import { RecordsGate } from "~/lib/events/records";
import { storableJson } from "~/lib/json-data";
import type { RecordedUsageFact } from "~/lib/usage";

export interface UsageStore {
  close(): Promise<void>;
  facts(): Promise<{
    readonly facts: readonly StoredUsage[];
    readonly revision: number;
  }>;
  mark(marker: RecordedUsageFact): Promise<void>;
  revision(): Promise<number>;
  save(fact: RecordedUsageFact): Promise<void>;
}

export type UsageOwner =
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "direct" };

export interface StoredUsage {
  readonly owner: UsageOwner;
  readonly value: unknown;
}

export function storedUsageFact(fact: RecordedUsageFact): RecordedUsageFact {
  return storableJson(
    `usage fact for turn ${JSON.stringify(fact.turnId)}`,
    fact
  ) as unknown as RecordedUsageFact;
}

export function ownerOf(fact: RecordedUsageFact): UsageOwner {
  return fact.scope === "run"
    ? { kind: "run", runId: fact.runId }
    : { kind: "direct" };
}

const text = z.string().min(1);
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

export const usageFactSchema = z.discriminatedUnion("scope", [
  base.extend({
    definitionId: text,
    path: z.array(text),
    runId: text,
    scope: z.literal("run"),
  }),
  base.extend({ scope: z.literal("direct") }),
]);

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

  #keep(fact: RecordedUsageFact): void {
    this.#facts.set(fact.turnId, { owner: ownerOf(fact), value: fact });
    this.#revision += 1;
  }
}
