import type {
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthTokens,
} from "@ai-sdk/mcp";

import type { SpawnStdio } from "./stdio";

/** Re-exported so consumers can implement OAuth without reaching into @ai-sdk/mcp. */
export type {
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthTokens,
};

interface McpServerMetadata {
  /** Catalog metadata — what the server offers. */
  description?: string;
  /** Stable key. Also the tool-name prefix: a server tool `x` becomes `${id}__x`. */
  id: string;
  /** Catalog metadata — human label. */
  name?: string;
}

/** A fully-resolved remote transport. Secret references are resolved by the host. */
export interface McpRemoteTransportConfig {
  authProvider?: OAuthClientProvider;
  headers?: Record<string, string>;
  kind: "remote";
  protocol: "http" | "sse";
  url: string;
}

/** A fully-resolved subprocess transport. The host owns trust and secret resolution. */
export interface McpStdioTransportConfig {
  args?: string[];
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  kind: "stdio";
}

export type McpTransportConfig =
  | McpRemoteTransportConfig
  | McpStdioTransportConfig;

/**
 * What a host hands the manager: the JSON that configures one server, plus
 * whether it should be running. An enabled definition connects on `define`;
 * a disabled one is registered and stays off.
 */
export type McpServerDefinition = McpServerMetadata & {
  transport: McpTransportConfig;
  enabled?: boolean;
};

/** Redacted connection detail safe for status, logs, and renderer surfaces. */
export type McpServerSummary = McpServerMetadata & {
  transport:
    | { kind: "remote"; protocol: "http" | "sse"; url: string }
    | {
        kind: "stdio";
        command: string;
        args: string[];
        cwd?: string;
        envNames: string[];
      };
};

/** Connection lifecycle of one client. `off` is both "disabled" and "closed". */
export type McpClientStatus = "off" | "connecting" | "connected" | "failed";

/** Live per-server state, for UI/status and a model-facing catalog. */
export interface McpServerState {
  enabled: boolean;
  /** Present when `status === "failed"`. */
  error?: string;
  id: string;
  /** Usage guidance the server sent at initialize; hosts add it to the prompt. */
  instructions?: string;
  /** The definition this state is for. */
  server: McpServerSummary;
  status: McpClientStatus;
  /** Tools contributed once connected (0 otherwise). */
  toolCount: number;
}

/** A resource the server offers; read it with `McpClient.readResource`. */
export interface McpResource {
  description?: string;
  mimeType?: string;
  name: string;
  uri: string;
}

/** One block of a read resource: text, or base64 for binary. */
export type McpResourceContent =
  | { uri: string; mimeType?: string; text: string }
  | { uri: string; mimeType?: string; blob: string };

/** A prompt template the server offers; expand it with `McpClient.getPrompt`. */
export interface McpPrompt {
  arguments?: { name: string; description?: string; required?: boolean }[];
  description?: string;
  name: string;
}

/** An expanded prompt message. Content the host cannot carry is stringified. */
export interface McpPromptMessage {
  content:
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type: "resource"; resource: McpResourceContent };
  role: "user" | "assistant";
}

/** A server asking the user for structured input mid-call. */
export interface McpElicitationRequest {
  message: string;
  /** Flat JSON-schema object (string/number/integer/boolean/enum properties). */
  requestedSchema: unknown;
  serverId: string;
}

export type McpElicitationResult =
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
