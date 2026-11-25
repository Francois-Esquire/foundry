import type { HarnessQuestionCallback } from "./harness";

// biome-ignore lint/complexity/noBannedTypes: WeakSet tracks tool execute functions by reference identity.
const questionExecutors = new WeakSet<Function>();

export interface HarnessQuestionToolSettings {
  question?: HarnessQuestionCallback;
  sessionId: string;
}

export function markHarnessQuestionExecutor(
  // biome-ignore lint/complexity/noBannedTypes: Marks a tool execute function by reference identity.
  execute: Function
): void {
  questionExecutors.add(execute);
}

export function isHarnessQuestionTool(candidate: {
  readonly execute?: unknown;
}): boolean {
  return (
    typeof candidate.execute === "function" &&
    questionExecutors.has(candidate.execute)
  );
}
