export interface HarnessActivity {
  actions?: readonly "stop"[];
  id: string;
  kind: "subagent" | "task" | "watch" | "schedule";
  lifetime: "session" | "sandbox";
  nativeId?: string;
  parentId?: string;
  status:
    | "running"
    | "waiting"
    | "complete"
    | "failed"
    | "cancelled"
    | "unknown";
  summary?: string;
  title: string;
}

export interface HarnessActivityEvent extends HarnessActivity {
  agentId: string;
  harness: string;
  revision: number;
  sessionId: string;
}

export interface HarnessToolEvent {
  activityId?: string;
  agentId: string;
  harness: string;
  inputSummary: string;
  outcome: "started" | "ran" | "refused" | "failed";
  reason?: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
}
