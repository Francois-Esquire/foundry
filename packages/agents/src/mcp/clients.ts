import type { ToolSet } from "ai";
import { composeTools } from "../tools/compose";
import type { McpClientEvents } from "./client";
import { McpClient } from "./client";
import { McpEmitter } from "./emitter";
import type {
  McpClientOptions,
  McpElicitationHandler,
  McpServerDefinition,
  McpServerState,
} from "./types";

export class McpClients extends McpEmitter<McpClientEvents> {
  readonly #options: McpClientOptions;
  readonly #clients = new Map<string, McpClient>();
  readonly #unsubscribe = new Map<string, () => void>();

  elicit: McpElicitationHandler | undefined;

  constructor(options: McpClientOptions = {}) {
    super();
    this.#options = options;
  }

  define(definition: McpServerDefinition): McpClient {
    const existing = this.#clients.get(definition.id);
    if (existing) {
      existing.update(definition);
      return existing;
    }
    const client = new McpClient(definition, this.#options);
    client.elicit = (request) =>
      this.elicit
        ? this.elicit(request)
        : Promise.resolve({ action: "decline" as const });
    const offs = [
      client.on("status", (c) => {
        this.emit("status", c);
      }),
      client.on("tools", (c) => {
        this.emit("tools", c);
      }),
      client.on("log", (m) => {
        this.emit("log", m);
      }),
    ];
    this.#clients.set(definition.id, client);
    this.#unsubscribe.set(definition.id, () => {
      for (const off of offs) {
        off();
      }
    });
    if (client.enabled) {
      client.connect();
    }
    return client;
  }

  enable(id: string): Promise<void> {
    return this.#require(id).enable();
  }

  disable(id: string): Promise<void> {
    return this.#require(id).disable();
  }

  async remove(id: string): Promise<void> {
    const client = this.#clients.get(id);
    if (!client) {
      return;
    }
    this.#clients.delete(id);
    this.#unsubscribe.get(id)?.();
    this.#unsubscribe.delete(id);
    await client.close();
  }

  client(id: string): McpClient | undefined {
    return this.#clients.get(id);
  }

  clients(): McpClient[] {
    return [...this.#clients.values()];
  }

  definitions(): McpServerDefinition[] {
    return this.clients().map((c) => c.definition);
  }

  async tools(): Promise<ToolSet> {
    let out: ToolSet = {};
    for (const client of this.#clients.values()) {
      if (!client.enabled) {
        continue;
      }
      await client.connect();
      if (client.status === "connected") {
        out = composeTools(out, client.tools());
      }
    }
    return out;
  }

  status(): McpServerState[] {
    return this.clients().map((c) => c.state());
  }

  async [Symbol.asyncDispose](): Promise<void> {
    const clients = this.clients();
    this.#clients.clear();
    for (const off of this.#unsubscribe.values()) {
      off();
    }
    this.#unsubscribe.clear();
    await Promise.all(clients.map((c) => c.close()));
  }

  #require(id: string): McpClient {
    const client = this.#clients.get(id);
    if (!client) {
      throw new Error(`Unknown MCP server "${id}"`);
    }
    return client;
  }
}
