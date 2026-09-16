/**
 * The OAuth flow driver (`auth`) and its error, re-exported so consumers can run
 * the authorization-code exchange without depending on `@ai-sdk/mcp` directly.
 */
export { auth as runMcpOAuth, UnauthorizedError } from "@ai-sdk/mcp";

export type { McpClientEvents } from "./client";
export { McpClient } from "./client";
export { McpManager } from "./manager";

export type { SpawnStdio, StdioTransportHooks } from "./stdio";
export { sdkStdioTransport, spawnStdioTransport } from "./stdio";
export type {
  McpClientOptions,
  McpClientStatus,
  McpElicitationHandler,
  McpElicitationRequest,
  McpElicitationResult,
  McpLogMessage,
  McpManagerOptions,
  McpPrompt,
  McpPromptMessage,
  McpRemoteTransportConfig,
  McpResource,
  McpResourceContent,
  McpServerDefinition,
  McpServerState,
  McpServerSummary,
  McpStdioTransportConfig,
  McpTransportConfig,
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthTokens,
} from "./types";
