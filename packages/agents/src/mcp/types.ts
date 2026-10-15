import type { OAuthClientProvider } from "@ai-sdk/mcp";
import type { McpServerDefinition as CoreMcpServerDefinition } from "@foundry/core/agents";

import type { SpawnStdio } from "./stdio";

/** The catalog shapes, with the remote transport's auth provider bound to the SDK's. */
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

/** A server asking the user for structured input mid-call. */
interface McpElicitationRequest {
  message: string;
  /** Flat JSON-schema object (string/number/integer/boolean/enum properties). */
  requestedSchema: unknown;
  serverId: string;
}

type McpElicitationResult =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "decline" | "cancel" };

export type McpElicitationHandler = (
  request: McpElicitationRequest
) => Promise<McpElicitationResult>;

/** A `notifications/message` log line from a server. */
export interface McpLogMessage {
  data: unknown;
  level: string;
  logger?: string;
  serverId: string;
}

/** The seams a host can swap; every client built by a manager shares them. */
export interface McpClientOptions {
  /**
   * How long a failed client stays un-retried before the next `connect()`
   * attempts it again. Guards against hammering a hard-down server while
   * still letting a transient blip self-heal. Defaults to 30s.
   */
  retryCooldownMs?: number;
  /**
   * How stdio servers are started. Defaults to a local child process; a host
   * that runs servers in a container or another runtime supplies its own.
   */
  spawnStdio?: SpawnStdio;
}

export type McpManagerOptions = McpClientOptions;
