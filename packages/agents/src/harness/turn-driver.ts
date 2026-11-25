import type {
  HarnessActivityEvent,
  HarnessCapabilities,
  HarnessPermissionProfile,
  HarnessQuestionCallback,
  HarnessToolEvent,
} from "@foundry/core/agents";
import type { ApprovalResolution } from "@foundry/lib/config/authorization";
import type { Output, ToolSet } from "ai";
import type { ModelRoute } from "../agents/model";
import type { AgentAuthorizer } from "../authorization/authorization";
import type {
  AgentApprovalRequest,
  SessionInput,
  SessionStream,
} from "../session/events";
import type { SessionMessage } from "../session/types";
import type { SessionStore } from "../store";
import type { TurnOptions } from "./session-harness";

export type {
  HarnessActivity,
  HarnessActivityEvent,
  HarnessCapabilities,
  HarnessPermissionCallback,
  HarnessPermissionProfile,
  HarnessPermissionRequest,
  HarnessPermissionResult,
  HarnessQuestion,
  HarnessQuestionCallback,
  HarnessQuestionRequest,
  HarnessQuestionResult,
  HarnessResponseFormat,
  HarnessToolEvent,
  HarnessTurnDriver,
} from "@foundry/core/agents";
// biome-ignore lint/performance/noBarrelFile: Preserve @foundry/agents/harness turn-driver helper re-export.
export { validateHarnessProfile } from "@foundry/core/agents";

export interface HarnessSession {
  readonly capabilities: HarnessCapabilities;
  close?(): Promise<void>;
  generate<OUTPUT extends Output.Output = never>(
    input: SessionInput,
    options?: TurnOptions<OUTPUT>
  ): Promise<SessionMessage>;
  interrupt(): Promise<void>;
  readonly route: ModelRoute;
  readonly sessionId: string;
  steer(input: string): Promise<void>;
  stopActivity?(id: string): Promise<void>;
  readonly store: SessionStore;
  stream<OUTPUT extends Output.Output = never>(
    input: SessionInput,
    options?: TurnOptions<OUTPUT>
  ): SessionStream<OUTPUT>;
}

export interface HarnessAuthoritySettings {
  agentGeneration?: number;
  agentId: string;
  approve?: (
    request: AgentApprovalRequest & {
      inputSummary?: string;
      sessionId: string;
      signal: AbortSignal;
      title?: string;
      suggestions?: unknown;
    }
  ) => Promise<ApprovalResolution>;
  onApprovalRequest?: (
    request: AgentApprovalRequest & {
      sessionId: string;
      approvalMode: "live" | "deferred";
    }
  ) => void | Promise<void>;
  policy: AgentAuthorizer;
  profile: HarnessPermissionProfile;
  store: SessionStore;
}

export interface DriverSessionSettings extends HarnessAuthoritySettings {
  model: ModelRoute;
  onActivity?: (event: HarnessActivityEvent) => void | Promise<void>;
  onToolEvent?: (event: HarnessToolEvent) => void;
  parentActivityId?: string;
  question?: HarnessQuestionCallback;
  sessionId?: string;
  tools?: ToolSet;
}
