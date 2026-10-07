import type { AgentModel, CompactionSettings } from "@foundry/agents/harness";
import { createModelSummarizer } from "@foundry/agents/session";
import type { SessionOptions } from "../types";

/** Resolve automatic compaction once, with the same contract on every network-model session. */
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
