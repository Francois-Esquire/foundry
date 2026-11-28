export interface HarnessQuestion {
  header?: string;
  id: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string }[];
  question: string;
}

export interface HarnessQuestionRequest {
  activityId?: string;
  questions: HarnessQuestion[];
  sessionId: string;
  signal: AbortSignal;
  toolCallId: string;
}

export type HarnessQuestionResult =
  | { outcome: "answered"; answers: Record<string, string[]> }
  | { outcome: "declined"; reason: string };

export type HarnessQuestionCallback = (
  request: HarnessQuestionRequest
) => Promise<HarnessQuestionResult>;

const HARNESS_QUESTION_EXECUTOR = Symbol.for(
  "@foundry/harness-question-executor"
);

export interface HarnessQuestionToolSettings {
  question?: HarnessQuestionCallback;
  sessionId: string;
}

export function markHarnessQuestionExecutor(
  // biome-ignore lint/complexity/noBannedTypes: Marks a tool execute function via a cross-realm symbol property.
  execute: Function
): void {
  Object.defineProperty(execute, HARNESS_QUESTION_EXECUTOR, {
    configurable: true,
    enumerable: false,
    value: true,
  });
}

export function isHarnessQuestionTool(candidate: {
  readonly execute?: unknown;
}): boolean {
  return (
    typeof candidate.execute === "function" &&
    (candidate.execute as unknown as Record<PropertyKey, unknown>)[
      HARNESS_QUESTION_EXECUTOR
    ] === true
  );
}
