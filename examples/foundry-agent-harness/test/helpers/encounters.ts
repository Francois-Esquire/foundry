import type { Encounter, Step, ToolUse } from "../../src/model/thread";
import { startEncounter } from "../../src/model/thread";

export const STARTED = 1_800_000_000_000;

export function encounter(overrides: Partial<Encounter> = {}): Encounter {
  return {
    ...startEncounter({
      goal: "Explain this example",
      id: "encounter-1",
      startedAt: STARTED,
      weapon: { effort: "medium", model: "sonnet" },
    }),
    ...overrides,
  };
}

export function tool(
  id: string,
  status: ToolUse["status"] = "success"
): ToolUse {
  return { detail: "", id, name: "Read", startedAt: STARTED, status };
}

export function step(overrides: Partial<Step> = {}): Step {
  return {
    streaming: false,
    text: "",
    title: "A step",
    tools: [],
    usage: null,
    ...overrides,
  };
}
