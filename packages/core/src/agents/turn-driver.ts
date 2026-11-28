import type { Output, TextStreamPart, ToolSet } from "ai";
import type {
  HarnessActivity,
  HarnessActivityEvent,
  HarnessToolEvent,
} from "./activity";
import type {
  HarnessPermissionCallback,
  HarnessPermissionProfile,
} from "./permission";
import type { HarnessQuestionCallback } from "./question";
import type {
  AgentApprovalRequest,
  SessionInput,
  ToolProvenance,
} from "./session-part";

export interface HarnessCapabilities {
  interruption: boolean;
  steering: boolean;
}

export type HarnessResponseFormat = Extract<
  Awaited<Output.Output["responseFormat"]>,
  { type: "json" }
>;

type SdkStreamPart = TextStreamPart<ToolSet>;

type RegisteredToolCallPart = Extract<SdkStreamPart, { type: "tool-call" }> & {
  provenance?: ToolProvenance;
};

type RegisteredApprovalRequestPart = Extract<
  SdkStreamPart,
  { type: "tool-approval-request" }
> &
  Partial<
    Pick<AgentApprovalRequest, "agentGeneration" | "agentId" | "capability">
  >;

export type HarnessStreamPart =
  | { type: "harness-activity"; event: HarnessActivityEvent }
  | { type: "harness-tool"; event: HarnessToolEvent }
  | ({ type: "harness-approval-request" } & AgentApprovalRequest);

export type StreamPart =
  | Exclude<SdkStreamPart, { type: "tool-call" | "tool-approval-request" }>
  | RegisteredToolCallPart
  | RegisteredApprovalRequestPart
  | HarnessStreamPart;

export interface HarnessTurnDriver {
  capabilities: HarnessCapabilities;
  close?: () => Promise<void>;
  id: string;
  interrupt?: () => Promise<void>;
  run(options: {
    input: SessionInput;
    sessionId: string;
    nativeSessionId?: string;
    signal: AbortSignal;
    profile: HarnessPermissionProfile;
    permission: HarnessPermissionCallback;
    question: HarnessQuestionCallback;
    tools?: ToolSet;
    onActivity: (activity: HarnessActivity) => Promise<void>;
    onToolEvent: (event: HarnessToolEvent) => Promise<void>;
    onSessionId: (nativeSessionId: string) => Promise<void>;
    responseFormat?: HarnessResponseFormat;
  }): Promise<AsyncIterable<StreamPart>>;
  steer?: (input: string) => Promise<void>;
  stopActivity?: (id: string) => Promise<void>;
}
