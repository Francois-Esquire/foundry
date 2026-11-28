import type { MCPClient, MCPClientConfig, MCPTransport } from "@ai-sdk/mcp";
import { createMCPClient, ElicitationRequestSchema } from "@ai-sdk/mcp";
import type { ToolSet } from "ai";

import type { Capability } from "../authorization/capability";
import { tagTool } from "../harness/tool-registration";
import type {
  McpClientOptions,
  McpElicitationHandler,
  McpLogMessage,
  SpawnStdio,
} from "./client-options";
import { McpEmitter } from "./emitter";
import type {
  McpClientStatus,
  McpPrompt,
  McpPromptMessage,
  McpResource,
  McpResourceContent,
  McpServerDefinition,
  McpServerState,
  McpServerSummary,
} from "./server-definition";

export interface McpClientEvents {
  log: McpLogMessage;
  status: McpClient;
  tools: McpClient;
}

interface Notification {
  method: string;
  params?: Record<string, unknown>;
}

const DEFAULT_RETRY_COOLDOWN_MS = 30_000;

function tapNotifications(
  transport: MCPTransport,
  handle: (notification: Notification) => void
): void {
  const forward = transport.onmessage;
  transport.onmessage = (message) => {
    if ("method" in message && !("id" in message)) {
      handle(message);
      return;
    }
    forward?.(message);
  };
}

function toPromptMessage(message: {
  role: "user" | "assistant";
  content: { type: string } & Record<string, unknown>;
}): McpPromptMessage {
  const { content } = message;
  if (content.type === "text" && typeof content.text === "string") {
    return {
      content: { text: content.text, type: "text" },
      role: message.role,
    };
  }
  if (
    content.type === "image" &&
    typeof content.data === "string" &&
    typeof content.mimeType === "string"
  ) {
    return {
      content: {
        data: content.data,
        mimeType: content.mimeType,
        type: "image",
      },
      role: message.role,
    };
  }
  if (content.type === "resource" && typeof content.resource === "object") {
    return {
      content: {
        resource: content.resource as McpResourceContent,
        type: "resource",
      },
      role: message.role,
    };
  }
  return {
    content: { text: JSON.stringify(content), type: "text" },
    role: message.role,
  };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function connectionSignature(c: McpServerDefinition): string {
  const { transport } = c;
  return transport.kind === "remote"
    ? JSON.stringify({
        hasAuth: transport.authProvider !== undefined,
        headers: transport.headers ?? {},
        kind: transport.kind,
        protocol: transport.protocol,
        url: transport.url,
      })
    : JSON.stringify({
        args: transport.args ?? [],
        command: transport.command,
        cwd: transport.cwd,
        env: transport.env ?? {},
        kind: transport.kind,
      });
}

function summarizeServer(c: McpServerDefinition): McpServerSummary {
  const metadata = {
    description: c.description,
    id: c.id,
    name: c.name,
  };
  return c.transport.kind === "remote"
    ? {
        ...metadata,
        transport: {
          kind: "remote",
          protocol: c.transport.protocol,
          url: c.transport.url,
        },
      }
    : {
        ...metadata,
        transport: {
          args: c.transport.args ?? [],
          command: c.transport.command,
          cwd: c.transport.cwd,
          envNames: Object.keys(c.transport.env ?? {}),
          kind: "stdio",
        },
      };
}

function redactError(server: McpServerDefinition, err: unknown): string {
  let message = err instanceof Error ? err.message : String(err);
  const values =
    server.transport.kind === "stdio"
      ? Object.values(server.transport.env ?? {})
      : Object.values(server.transport.headers ?? {});
  for (const value of values) {
    if (value.length > 0) {
      message = message.replaceAll(value, "[redacted]");
    }
  }
  return message;
}

function toTaggedTools(server: McpServerDefinition, raw: ToolSet): ToolSet {
  const out: ToolSet = {};
  for (const [name, serverTool] of Object.entries(raw)) {
    out[`${server.id}__${name}`] = tagTool(serverTool, {
      capability: (): Capability => ({
        kind: "mcp.tool",
        serverId: server.id,
        tool: name,
      }),
      source: "mcp",
    });
  }
  return out;
}

export class McpClient extends McpEmitter<McpClientEvents> {
  readonly #spawnStdio: SpawnStdio | undefined;
  readonly #retryCooldownMs: number;
  #definition: McpServerDefinition;
  #status: McpClientStatus = "off";
  #error: string | undefined;
  #instructions: string | undefined;
  #tools: ToolSet = {};
  #client: MCPClient | undefined;
  #failedAt: number | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  elicit: McpElicitationHandler | undefined;

  constructor(definition: McpServerDefinition, options: McpClientOptions = {}) {
    super();
    this.#definition = definition;
    this.#spawnStdio = options.spawnStdio;
    this.#retryCooldownMs =
      options.retryCooldownMs ?? DEFAULT_RETRY_COOLDOWN_MS;
  }

  get id(): string {
    return this.#definition.id;
  }
  get definition(): McpServerDefinition {
    return this.#definition;
  }
  get enabled(): boolean {
    return this.#definition.enabled === true;
  }
  get status(): McpClientStatus {
    return this.#status;
  }
  get error(): string | undefined {
    return this.#error;
  }
  get instructions(): string | undefined {
    return this.#instructions;
  }

  tools(): ToolSet {
    return this.#tools;
  }

  state(): McpServerState {
    return {
      enabled: this.enabled,
      error: this.#error,
      id: this.id,
      instructions: this.#instructions,
      server: summarizeServer(this.#definition),
      status: this.#status,
      toolCount: Object.keys(this.#tools).length,
    };
  }

  update(definition: McpServerDefinition): Promise<void> {
    return this.#serialize(async () => {
      const changed =
        connectionSignature(this.#definition) !==
        connectionSignature(definition);
      const wasEnabled = this.enabled;
      this.#definition = definition;
      if (!this.enabled) {
        await this.#close();
      } else if (changed || !wasEnabled) {
        await this.#close();
        await this.#open();
      } else {
        await this.#connectIfDue();
      }
    });
  }

  enable(): Promise<void> {
    return this.update({ ...this.#definition, enabled: true });
  }

  disable(): Promise<void> {
    return this.update({ ...this.#definition, enabled: false });
  }

  connect(): Promise<void> {
    return this.#serialize(() => this.#connectIfDue());
  }

  close(): Promise<void> {
    return this.#serialize(() => this.#close());
  }

  refresh(): Promise<void> {
    return this.#serialize(async () => {
      const client = this.#connected();
      await this.#relist(client);
      this.emit("tools", this);
    });
  }

  async listResources(): Promise<McpResource[]> {
    const result = await this.#connected().listResources();
    return result.resources.map((r) => ({
      description: r.description,
      mimeType: r.mimeType,
      name: r.name,
      uri: r.uri,
    }));
  }

  async readResource(uri: string): Promise<McpResourceContent[]> {
    const result = await this.#connected().readResource({ uri });
    return result.contents.map((c) => {
      const base = { mimeType: c.mimeType, uri: c.uri };
      return "blob" in c
        ? { ...base, blob: asString(c.blob) }
        : { ...base, text: asString(c.text) };
    });
  }

  async listPrompts(): Promise<McpPrompt[]> {
    const result = await this.#connected().experimental_listPrompts();
    return result.prompts.map((p) => ({
      arguments: p.arguments?.map((a) => ({
        description: a.description,
        name: a.name,
        required: a.required,
      })),
      description: p.description,
      name: p.name,
    }));
  }

  async getPrompt(
    name: string,
    args?: Record<string, string>
  ): Promise<McpPromptMessage[]> {
    const result = await this.#connected().experimental_getPrompt({
      arguments: args,
      name,
    });
    return result.messages.map(toPromptMessage);
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  #connected(): MCPClient {
    if (this.#status !== "connected" || !this.#client) {
      throw new Error(
        `MCP server "${this.id}" is not connected${this.#error ? `: ${this.#error}` : ""}`
      );
    }
    return this.#client;
  }

  #setStatus(status: McpClientStatus, error?: string): void {
    this.#status = status;
    this.#error = error;
    this.emit("status", this);
  }

  async #connectIfDue(): Promise<void> {
    if (this.#status === "connected") {
      return;
    }
    if (
      this.#status === "failed" &&
      this.#failedAt !== undefined &&
      Date.now() - this.#failedAt < this.#retryCooldownMs
    ) {
      return;
    }
    await this.#open();
  }

  async #close(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    this.#tools = {};
    this.#instructions = undefined;
    this.#failedAt = undefined;
    try {
      if (client) {
        await client.close();
      }
    } catch (err) {
      this.emit("log", {
        data: redactError(this.#definition, err),
        level: "error",
        serverId: this.id,
      });
    }
    if (this.#status !== "off") {
      this.#setStatus("off");
    }
  }

  async #relist(client: MCPClient): Promise<void> {
    this.#tools = toTaggedTools(this.#definition, await client.tools());
  }

  #onStdioExit(code: number | null, signal: string | null): void {
    if (!this.#client) {
      return;
    }
    const why = signal ? `signal ${signal}` : `code ${String(code)}`;
    this.#client = undefined;
    this.#tools = {};
    this.#failedAt = Date.now();
    this.#setStatus("failed", `MCP server "${this.id}" exited (${why})`);
  }

  #onNotification(notification: Notification): void {
    switch (notification.method) {
      case "notifications/tools/list_changed": {
        const client = this.#client;
        if (!client) {
          return;
        }
        this.#serialize(() => this.#relist(client)).then(
          () => {
            this.emit("tools", this);
          },
          (err: unknown) => {
            this.#setStatus("failed", redactError(this.#definition, err));
          }
        );
        return;
      }
      case "notifications/message": {
        const params = notification.params ?? {};
        this.emit("log", {
          data: params.data,
          level: typeof params.level === "string" ? params.level : "info",
          logger: typeof params.logger === "string" ? params.logger : undefined,
          serverId: this.id,
        });
        return;
      }
      default:
        return;
    }
  }

  async #open(): Promise<void> {
    this.#setStatus("connecting");
    try {
      const { transport } = this.#definition;
      let stdio: MCPTransport | undefined;
      let transportConfig: MCPClientConfig["transport"];
      if (transport.kind === "stdio") {
        if (!this.#spawnStdio) {
          throw new Error(
            `MCP server "${this.id}" uses stdio transport, which requires a spawnStdio adapter; in Node pass spawnStdioTransport or use createNodeMcpClient from "@foundry/agents/node".`
          );
        }
        stdio = this.#spawnStdio(transport, {
          onExit: (code, signal) => {
            this.#onStdioExit(code, signal);
          },
          onStderr: (line) => {
            this.emit("log", {
              data: line,
              level: "error",
              logger: "stderr",
              serverId: this.id,
            });
          },
        });
        transportConfig = stdio;
      } else {
        transportConfig = {
          authProvider: transport.authProvider,
          headers: transport.headers,
          redirect: "error",
          type: transport.protocol,
          url: transport.url,
        };
      }
      const client = await createMCPClient({
        capabilities: { elicitation: {} },
        transport: transportConfig,
      });
      this.#client = client;
      if (stdio) {
        tapNotifications(stdio, (n) => {
          this.#onNotification(n);
        });
      }
      client.onElicitationRequest(ElicitationRequestSchema, (request) =>
        this.elicit
          ? this.elicit({
              message: request.params.message,
              requestedSchema: request.params.requestedSchema,
              serverId: this.id,
            })
          : Promise.resolve({ action: "decline" as const })
      );
      await this.#relist(client);
      this.#instructions = client.instructions;
      this.#failedAt = undefined;
      this.#setStatus("connected");
    } catch (err) {
      this.#failedAt = Date.now();
      this.#setStatus("failed", redactError(this.#definition, err));
    }
  }
}
