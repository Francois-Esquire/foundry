import type { Loadout } from "@/model/context";
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
  readonly loadout: Loadout;
  readonly outcome: Outcome;
  readonly steps: number;
  readonly swapped: boolean;
  readonly tokens: Tokens;
}

export function factsOf(encounter: Encounter, limit: number): Facts {
  const tools = encounter.steps.flatMap((step) => step.tools);
  return {
    calls: tools.length,
    duration: (encounter.endedAt ?? encounter.startedAt) - encounter.startedAt,
    failedCalls: tools.filter((tool) => tool.status === "error").length,
    finished: finishedTodos(encounter.todos),
    left: 1 - occupancyOf(encounter.steps, limit).used,
    loadout: encounter.loadout,
    outcome: encounter.outcome,
    steps: encounter.todos.length,
    swapped: encounter.swapped,
    tokens: tokensOf(encounter),
  };
}
