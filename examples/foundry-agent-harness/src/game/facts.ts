import type { Weapon } from "@/model/context";
import { occupancyOf } from "@/model/occupancy";
import {
  type Encounter,
  finishedTodos,
  type Outcome,
  type Tokens,
  tokensOf,
} from "@/model/thread";

export interface Facts {
  readonly calls: number;
  readonly duration: number;
  readonly failedCalls: number;
  readonly finished: number;
  readonly left: number;
  readonly outcome: Outcome;
  readonly rearmed: boolean;
  readonly steps: number;
  readonly tokens: Tokens;
  readonly weapon: Weapon;
}

export function factsOf(encounter: Encounter, limit: number): Facts {
  const tools = encounter.steps.flatMap((step) => step.tools);
  return {
    calls: tools.length,
    duration: (encounter.endedAt ?? encounter.startedAt) - encounter.startedAt,
    failedCalls: tools.filter((tool) => tool.status === "error").length,
    finished: finishedTodos(encounter.todos),
    left: 1 - occupancyOf(encounter.steps, limit).used,
    outcome: encounter.outcome,
    rearmed: encounter.rearmed,
    steps: encounter.todos.length,
    tokens: tokensOf(encounter),
    weapon: encounter.weapon,
  };
}
