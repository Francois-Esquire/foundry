import type { MCPClient, MCPClientConfig, MCPTransport } from "@ai-sdk/mcp";
import { createMCPClient, ElicitationRequestSchema } from "@ai-sdk/mcp";
import type { ToolSet } from "ai";

import type { Capability } from "../authorization";
import { tagTool } from "../harness/types";
import { McpEmitter } from "./emitter";
import { spawnStdioTransport } from "./stdio";
import type {
  McpClientOptions,
  McpClientStatus,
  McpElicitationHandler,
  McpLogMessage,
  McpPrompt,
  McpPromptMessage,
  McpResource,
  McpResourceContent,
  McpServerDefinition,
  McpServerState,
  McpServerSummary,
} from "./types";

export interface McpClientEvents {
  /**
   * A server log line (stdio servers only; remote transports do not surface
   * notifications). Stderr arrives here too, one line per message, at level
   * `error` with logger `stderr`.
   */
  log: McpLogMessage;
  /** Status, error, or instructions changed. */
  status: McpClient;
  /** The tool list was re-read; hosts rebuild their tool set. */
  tools: McpClient;
}

interface Notification {
  method: string;
  params?: Record<string, unknown>;
}

/** A failed client waits this long before the next `connect()` retries it. */
const DEFAULT_RETRY_COOLDOWN_MS = 30_000;

/**
 * Route server notifications (a `method` with no `id`) to `handle` before the
 * SDK sees them: the SDK client reports every notification as an error and
 * offers no handler of its own. Installed after connect, so the SDK's own
 * `onmessage` is already in place to forward everything else to.
 */
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

/** The SDK types resource payloads loosely; the host contract is a string. */
function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

/** Connection-affecting identity of a definition — metadata and `enabled` excluded. */
export function connectionSignature(c: McpServerDefinition): string {
  const transport = c.transport;
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
    id: c.id,
    ...(c.name === undefined ? {} : { name: c.name }),
    ...(c.description === undefined ? {} : { description: c.description }),
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
          kind: "stdio",
          ...(c.transport.cwd === undefined ? {} : { cwd: c.transport.cwd }),
          envNames: Object.keys(c.transport.env ?? {}),
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

/**
 * Server-prefix a server's raw tools and tag each with `source: "mcp"` and an
 * exact `mcp.tool` capability. No approval/policy wrapping happens here —
 * that decision belongs entirely to the harness's policy once these tools
 * reach the compiler, so the absence of a client-level approval handler can
 * never be mistaken for automatic execution.
 */
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

/**
 * One MCP server: its definition, and the live client run for it. Build one
 * from a definition and it is ready to `connect()`; an enabled definition
 * connects the moment a manager defines it. Status, tool changes, and logs
 * arrive as events, so nothing has to be wired at construction.
 */
export class McpClient extends McpEmitter<McpClientEvents> {
  readonly #spawnStdio: NonNullable<McpClientOptions["spawnStdio"]>;
  readonly #retryCooldownMs: number;
  #definition: McpServerDefinition;
  #status: McpClientStatus = "off";
  #error: string | undefined;
  #instructions: string | undefined;
  #tools: ToolSet = {};
  #client: MCPClient | undefined;
  /** When the last connect attempt failed (epoch ms); gates the retry cooldown. */
  #failedAt: number | undefined;
  /** Serializes connect/close/refresh so they never interleave. */
  #queue: Promise<unknown> = Promise.resolve();

  /**
   * Answers the server's elicitation requests. The capability is always
   * advertised; while this is unset the client declines on the user's behalf.
   */
  elicit: McpElicitationHandler | undefined;

  constructor(definition: McpServerDefinition, options: McpClientOptions = {}) {
    super();
    this.#definition = definition;
    this.#spawnStdio = options.spawnStdio ?? spawnStdioTransport;
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

  /** Tools this client currently offers: `${id}__name`, capability-tagged. Empty unless connected. */
  tools(): ToolSet {
    return this.#tools;
  }

  state(): McpServerState {
    return {
      enabled: this.enabled,
      id: this.id,
      status: this.#status,
      toolCount: Object.keys(this.#tools).length,
      ...(this.#error === undefined ? {} : { error: this.#error }),
      ...(this.#instructions === undefined
        ? {}
        : { instructions: this.#instructions }),
      server: summarizeServer(this.#definition),
    };
  }

  /**
   * Replace the definition. A connection-detail change or a fresh enable
   * drops the live connection and reconnects immediately; a metadata-only
   * change keeps it, and a redefinition that changes nothing leaves a
   * failed client to its cooldown.
   */
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

  /** Mark enabled and connect. */
  enable(): Promise<void> {
    return this.update({ ...this.#definition, enabled: true });
  }

  /** Mark disabled and close. */
  disable(): Promise<void> {
    return this.update({ ...this.#definition, enabled: false });
  }

  /**
   * Connect if not already. A client that failed waits out its cooldown
   * before trying again, so a transient blip self-heals on a later call
   * while a hard-down server is not hammered.
   */
  connect(): Promise<void> {
    return this.#serialize(() => this.#connectIfDue());
  }

  close(): Promise<void> {
    return this.#serialize(() => this.#close());
  }

  /** Re-read the tool list (the manual path for remote servers). */
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
      name: r.name,
      uri: r.uri,
      ...(r.description === undefined ? {} : { description: r.description }),
      ...(r.mimeType === undefined ? {} : { mimeType: r.mimeType }),
    }));
  }

  async readResource(uri: string): Promise<McpResourceContent[]> {
    const result = await this.#connected().readResource({ uri });
    return result.contents.map((c) => {
      const base = {
        uri: c.uri,
        ...(c.mimeType === undefined ? {} : { mimeType: c.mimeType }),
      };
      return "blob" in c
        ? { ...base, blob: asString(c.blob) }
        : { ...base, text: asString(c.text) };
    });
  }

  async listPrompts(): Promise<McpPrompt[]> {
    const result = await this.#connected().experimental_listPrompts();
    return result.prompts.map((p) => ({
      name: p.name,
      ...(p.description === undefined ? {} : { description: p.description }),
      ...(p.arguments
        ? {
            arguments: p.arguments.map((a) => ({
              name: a.name,
              ...(a.description === undefined
                ? {}
                : { description: a.description }),
              ...(a.required === undefined ? {} : { required: a.required }),
            })),
          }
        : {}),
    }));
  }

  async getPrompt(
    name: string,
    args?: Record<string, string>
  ): Promise<McpPromptMessage[]> {
    const result = await this.#connected().experimental_getPrompt({
      name,
      ...(args ? { arguments: args } : {}),
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
    // The manager voids close paths it does not await; a transport that
    // fails to shut down must land in status, never as an unhandled rejection.
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

  /**
   * A subprocess that ends while we still hold its client died on its own:
   * drop the client and record the exit so the next `connect()` retries
   * after the cooldown. A close we asked for has already cleared the client.
   */
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
        void this.#serialize(() => this.#relist(client)).then(
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
          level: typeof params.level === "string" ? params.level : "info",
          serverId: this.id,
          ...(typeof params.logger === "string"
            ? { logger: params.logger }
            : {}),
          data: params.data,
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
      const transport = this.#definition.transport;
      // Only a transport we construct can be tapped for notifications; the
      // SDK builds remote transports internally and exposes no hook.
      let stdio: MCPTransport | undefined;
      let transportConfig: MCPClientConfig["transport"];
      if (transport.kind === "stdio") {
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
          type: transport.protocol,
          url: transport.url,
          ...(transport.headers ? { headers: transport.headers } : {}),
          ...(transport.authProvider
            ? { authProvider: transport.authProvider }
            : {}),
          // Reject redirects: an MCP endpoint that 30x-redirects is an SSRF risk.
          redirect: "error",
        };
      }
      const client = await createMCPClient({
        capabilities: { elicitation: {} },
        transport: transportConfig,
      });
      // Register the live client before `tools()` so a listing failure still
      // closes the connection on dispose rather than leaking it.
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
