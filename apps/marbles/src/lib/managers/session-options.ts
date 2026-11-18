import type { AgentModel, CompactionSettings } from "@foundry/agents/harness";
import { createModelSummarizer } from "@foundry/agents/session";
import { stepCountIs } from "ai";
import type { SessionOptions } from "../types";

export function resolveCompaction(
  option: SessionOptions["compaction"],
  model: AgentModel
): CompactionSettings | undefined {
  if (!option) {
    return undefined;
  }
  return {
    summarizer: createModelSummarizer({ model }),
    ...(option === true ? {} : option),
  };
}

export type TurnLimit =
  | {
      readonly kind: "steps";
      readonly stopWhen: ReturnType<typeof stepCountIs>;
    }
  | { readonly kind: "native"; readonly turns: number };

export class TurnLimitUnsupportedError extends Error {
  readonly code = "TURN_LIMIT_UNSUPPORTED";
  override readonly name = "TurnLimitUnsupportedError";
}

export function resolveTurnLimit(
  turns: number | undefined,
  mode: TurnLimit["kind"]
): TurnLimit | undefined {
  if (turns === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(turns) || turns < 1) {
    throw new Error("maxTurns must be a positive safe integer");
  }
  return mode === "native"
    ? { kind: "native", turns }
    : { kind: "steps", stopWhen: stepCountIs(turns) };
}
