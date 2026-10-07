import { ReactiveStore } from "@foundry/lib/config/reactive-store";
import type { Path, ValueAt } from "@foundry/lib/config/types";
import { z } from "zod";

import type { KindDefault, ModelKind } from "./types";
import { MODEL_KINDS } from "./types";

export interface AgentConfigType {
  defaults?: Partial<Record<ModelKind, KindDefault>>;
  maxTokens?: number;
}

export type AgentConfigTypeKey = keyof AgentConfigType;

export interface AgentConfigEvents {
  changed: [next: Readonly<AgentConfigType>, prev: Readonly<AgentConfigType>];
}

const KindDefaultSchema = z.object({
  modelId: z.string().optional(),
  provider: z.string(),
});

const AgentConfigSchema = z
  .object({
    defaults: z
      .partialRecord(z.enum(MODEL_KINDS), KindDefaultSchema)
      .optional(),
    maxTokens: z.number().optional(),
  })
  .catchall(z.unknown());

/**
 * Holds a config that always satisfies its schema: the initial values are
 * checked on construction and every commit (`set`, `patch`, `reset`) before
 * it lands, so an invalid value is refused where it enters, never discovered
 * by a later, unrelated write.
 */
export class AgentConfig extends ReactiveStore<Record<string, unknown>> {
  constructor(initial: AgentConfigType = {}) {
    super(validated(initial as Record<string, unknown>));
  }

  get<P extends Path<AgentConfigType>>(path: P): ValueAt<AgentConfigType, P>;
  get(path: string): unknown;
  get(path: string): unknown {
    return super.get(path);
  }

  override set<P extends Path<AgentConfigType>>(
    path: P,
    value: ValueAt<AgentConfigType, P>
  ): void;
  override set(path: string, value: unknown): void;
  override set(path: string, value: unknown): void {
    super.set(path, value);
  }

  /** An invalid next config throws and leaves the value untouched. */
  protected override commit(
    before: Record<string, unknown>,
    after: Record<string, unknown>
  ): void {
    super.commit(before, validated(after));
  }
}

function validated(config: Record<string, unknown>): Record<string, unknown> {
  AgentConfigSchema.parse(config);
  return config;
}
