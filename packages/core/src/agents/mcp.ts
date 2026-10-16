/**
 * The catalog shapes of an MCP server: what a host declares, what a status
 * surface shows, and what a server offers. The live client, its transport
 * hooks, and its auth provider stay in the agents package; the remote
 * transport's `authProvider` is left open here for that reason.
 */

export interface McpServerMetadata {
  /** Catalog metadata — what the server offers. */
  description?: string;
  /** Stable key. Also the tool-name prefix: a server tool `x` becomes `${id}__x`. */
  id: string;
  /** Catalog metadata — human label. */
  name?: string;
}

/** A fully-resolved remote transport. Secret references are resolved by the host. */
export interface McpRemoteTransportConfig<Auth = unknown> {
  authProvider?: Auth;
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

export type McpTransportConfig<Auth = unknown> =
  | McpRemoteTransportConfig<Auth>
  | McpStdioTransportConfig;

/**
 * What a host hands the manager: the JSON that configures one server, plus
 * whether it should be running. An enabled definition connects on `define`;
 * a disabled one is registered and stays off.
 */
export type McpServerDefinition<Auth = unknown> = McpServerMetadata & {
  transport: McpTransportConfig<Auth>;
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
