import type { HarnessToolEvent, HarnessTurnDriver } from "@foundry/core/agents";
import { record } from "./payload";

export type DriverRun = Parameters<HarnessTurnDriver["run"]>[0];

export interface ToolReport {
  activityId?: string;
  input: unknown;
  outcome: HarnessToolEvent["outcome"];
  reason?: string;
  toolCallId: string;
  toolName: string;
}

export type ReportTool = (report: ToolReport) => Promise<void>;

export function toolReporter(
  agentId: string,
  harness: string,
  currentRun: () => DriverRun
): { report: ReportTool; reset: () => void } {
  const seen = new Set<string>();
  return {
    async report(event) {
      const key = `${event.toolCallId}:${event.outcome}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      const run = currentRun();
      await run.onToolEvent({
        ...(event.activityId ? { activityId: event.activityId } : {}),
        agentId,
        harness,
        inputSummary: inputSummary(event.input),
        outcome: event.outcome,
        sessionId: run.sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ...(event.reason ? { reason: event.reason } : {}),
      });
    },
    reset() {
      seen.clear();
    },
  };
}

function inputSummary(input: unknown): string {
  return `Input fields: ${Object.keys(record(input)).sort().join(", ") || "none"}`;
}
