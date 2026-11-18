export interface McpServerMetadata {
  description?: string;
  id: string;
  name?: string;
}

export interface McpRemoteTransportConfig<Auth = unknown> {
  authProvider?: Auth;
  headers?: Record<string, string>;
  kind: "remote";
  protocol: "http" | "sse";
  url: string;
}

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

export type McpServerDefinition<Auth = unknown> = McpServerMetadata & {
  transport: McpTransportConfig<Auth>;
  enabled?: boolean;
};

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

export type McpClientStatus = "off" | "connecting" | "connected" | "failed";

export interface McpServerState {
  enabled: boolean;
  error?: string;
  id: string;
  instructions?: string;
  server: McpServerSummary;
  status: McpClientStatus;
  toolCount: number;
}

export interface McpResource {
  description?: string;
  mimeType?: string;
  name: string;
  uri: string;
}

export type McpResourceContent =
  | { uri: string; mimeType?: string; text: string }
  | { uri: string; mimeType?: string; blob: string };

export interface McpPrompt {
  arguments?: { name: string; description?: string; required?: boolean }[];
  description?: string;
  name: string;
}

export interface McpPromptMessage {
  content:
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type: "resource"; resource: McpResourceContent };
  role: "user" | "assistant";
}
