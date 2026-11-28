import type { OAuthClientProvider } from "@ai-sdk/mcp";
import type { McpServerDefinition as CoreMcpServerDefinition } from "@foundry/core/agents";

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
