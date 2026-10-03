import type { ToolSet } from "ai";

import type { ModelRoute } from "../agents/model";
import type {
  AgentAuthorizer,
  ApprovalResolution,
  Capability,
  ToolSource,
} from "../authorization";
import type {
  AgentApprovalRequest,
  SessionInput,
  SessionMessage,
  SessionStore,
  SessionStream,
} from "../session";
import type { SessionStreamOptions } from "./session-harness";
import type { StreamPart } from "./stream-transform";

export interface HarnessPermissionProfile {
  allowedTools: readonly string[];
  disallowedTools: readonly string[];
  maxSteps: number;
  mode: "scheduled" | "attended";
  unresolved: "ask" | "deny";
}

export function validateHarnessProfile(
  profile: HarnessPermissionProfile
): void {
  if (!Number.isSafeInteger(profile.maxSteps) || profile.maxSteps < 1) {
    throw new Error("Harness maxSteps must be a positive safe integer.");
  }
}

export interface HarnessPermissionRequest {
  capability?: Capability;
  input: unknown;
  sessionId: string;
  signal: AbortSignal;
  source?: ToolSource;
  suggestions?: unknown;
  title?: string;
  toolCallId: string;
  toolName: string;
}

export type HarnessPermissionResult =
  | { behavior: "allow"; updatedInput?: unknown }
  | { behavior: "deny"; message: string };

export type HarnessPermissionCallback = (
  request: HarnessPermissionRequest
) => Promise<HarnessPermissionResult>;

export interface HarnessToolEvent {
  agentId: string;
  harness: string;
  inputSummary: string;
  outcome: "started" | "ran" | "refused" | "failed";
  reason?: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
}

export interface HarnessCapabilities {
  interruption: boolean;
  steering: boolean;
}

/** A CLI owns its loop and history. run receives only the newly submitted input. */
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
    tools?: ToolSet;
    onToolEvent: (event: HarnessToolEvent) => Promise<void>;
    onSessionId: (nativeSessionId: string) => Promise<void>;
  }): Promise<AsyncIterable<StreamPart>>;
  steer?: (input: string) => Promise<void>;
}

export interface HarnessSession {
  readonly capabilities: HarnessCapabilities;
  close?(): Promise<void>;
  generate(
    input: SessionInput,
    options?: SessionStreamOptions
  ): Promise<SessionMessage>;
  interrupt(): Promise<void>;
  readonly route: ModelRoute;
  readonly sessionId: string | undefined;
  steer(input: string): Promise<void>;
  readonly store: SessionStore | undefined;
  stream(input: SessionInput, options?: SessionStreamOptions): SessionStream;
}

export interface HarnessAuthoritySettings {
  agentGeneration?: number;
  agentId: string;
  /** Live attended callback. This must never suspend/replay a workflow. */
  approve?: (
    request: AgentApprovalRequest & {
      /** input is the exact operation and may contain secrets. It is only
       * delivered to this live host callback; persist inputSummary instead. */
      inputSummary?: string;
      sessionId: string;
      signal: AbortSignal;
      title?: string;
      suggestions?: unknown;
    }
  ) => Promise<ApprovalResolution>;
  onApprovalRequest?: (
    request: AgentApprovalRequest & { sessionId: string }
  ) => void;
  policy: AgentAuthorizer;
  profile: HarnessPermissionProfile;
  store: SessionStore;
}

export interface DriverSessionSettings extends HarnessAuthoritySettings {
  model: ModelRoute;
  onToolEvent?: (event: HarnessToolEvent) => void;
  sessionId?: string;
  tools?: ToolSet;
}
