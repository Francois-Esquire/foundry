import type { MCPTransport, OAuthClientProvider } from "@ai-sdk/mcp";
import type {
  McpServerDefinition as CoreMcpServerDefinition,
  McpStdioTransportConfig,
} from "@foundry/core/agents";

export type McpServerDefinition = CoreMcpServerDefinition<OAuthClientProvider>;
export type {
  McpClientStatus,
  McpPrompt,
  McpPromptMessage,
  McpResource,
  McpResourceContent,
  McpServerState,
  McpServerSummary,
} from "@foundry/core/agents";

export interface StdioTransportHooks {
  onExit?: (code: number | null, signal: string | null) => void;
  onStderr?: (line: string) => void;
}

export type SpawnStdio = (
  config: McpStdioTransportConfig,
  hooks: StdioTransportHooks
) => MCPTransport;

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
