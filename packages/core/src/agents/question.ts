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
