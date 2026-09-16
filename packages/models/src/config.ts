import { setDeepPreserveUndefined } from "@foundry/lib/config/helpers";
import { ReactiveStore } from "@foundry/lib/config/reactive-store";
import type { Path, ValueAt } from "@foundry/lib/config/types";
import { z } from "zod";

import type { KindDefault, ModelKind } from "./types";

export interface AgentConfigType {
  defaults?: Partial<Record<ModelKind, KindDefault>>;
  maxTokens?: number;
}

export type AgentConfigTypeKey = keyof AgentConfigType;

export interface AgentConfigEvents {
  changed: [next: Readonly<AgentConfigType>, prev: Readonly<AgentConfigType>];
}

const AgentConfigSchema = z
  .object({ maxTokens: z.number().optional() })
  .catchall(z.unknown());

export class AgentConfig extends ReactiveStore<Record<string, unknown>> {
  constructor(initial: AgentConfigType = {}) {
    super(initial as Record<string, unknown>);
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
    // Validate the would-be next config before committing; an invalid write
    // throws and leaves the value untouched.
    const candidate = setDeepPreserveUndefined(
      this._values,
      path.split("."),
      value
    );
    AgentConfigSchema.parse(candidate);
    super.set(path, value);
  }
}
