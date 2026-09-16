import type { ToolSet } from "ai";

import type { McpClientEvents } from "./client";
import { McpClient } from "./client";
import { McpEmitter } from "./emitter";
import type {
  McpElicitationHandler,
  McpManagerOptions,
  McpServerDefinition,
  McpServerState,
} from "./types";

/**
 * The set of {@link McpClient}s a host runs, keyed by definition id. Holds
 * the definitions (what a host persists) and the clients (what runs for
 * them). Every client event is re-emitted here under the same name, so a
 * host can listen once or per client.
 */
export class McpManager extends McpEmitter<McpClientEvents> {
  readonly #options: McpManagerOptions;
  readonly #clients = new Map<string, McpClient>();
  readonly #unsubscribe = new Map<string, () => void>();

  /** Default elicitation handler for every client that has none of its own. */
  elicit: McpElicitationHandler | undefined;

  constructor(options: McpManagerOptions = {}) {
    super();
    this.#options = options;
  }

  /**
   * Register or update a definition. An enabled definition connects in the
   * background; await {@link McpManager.tools} or the client's `connect()`
   * to wait for it.
   */
  define(definition: McpServerDefinition): McpClient {
    const existing = this.#clients.get(definition.id);
    if (existing) {
      void existing.update(definition);
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
      void client.connect();
    }
    return client;
  }

  enable(id: string): Promise<void> {
    return this.#require(id).enable();
  }

  disable(id: string): Promise<void> {
    return this.#require(id).disable();
  }

  /** Close and forget a definition. */
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

  /**
   * The merged tools of every enabled, connected client, namespaced
   * `<serverId>__<tool>`. Enabled clients that are not connected are
   * connected first (a failed one only after its cooldown). Later
   * definitions win a same-name collision.
   */
  async tools(): Promise<ToolSet> {
    const out: ToolSet = {};
    for (const client of this.#clients.values()) {
      if (!client.enabled) {
        continue;
      }
      await client.connect();
      if (client.status === "connected") {
        Object.assign(out, client.tools());
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
