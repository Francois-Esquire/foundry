import type { OAuthClientProvider } from "@ai-sdk/mcp";
import type { McpServerDefinition as CoreMcpServerDefinition } from "@foundry/core/agents";

import type { SpawnStdio } from "./stdio";

export type McpServerDefinition = CoreMcpServerDefinition<OAuthClientProvider>;
export type {
  McpClientStatus,
  McpPrompt,
  McpPromptMessage,
  McpResource,
  McpResourceContent,
  McpServerState,
  McpServerSummary,
  McpStdioTransportConfig,
} from "@foundry/core/agents";

interface McpElicitationRequest {
  message: string;
  requestedSchema: unknown;
  serverId: string;
}

type McpElicitationResult =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "decline" | "cancel" };

export type McpElicitationHandler = (
  request: McpElicitationRequest
) => Promise<McpElicitationResult>;

export interface McpLogMessage {
  data: unknown;
  level: string;
  logger?: string;
  serverId: string;
}

export interface McpClientOptions {
  retryCooldownMs?: number;
  spawnStdio?: SpawnStdio;
}

export type McpManagerOptions = McpClientOptions;
