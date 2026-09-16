import type { ModelMessage } from "ai";

import type { AgentAuthorizer } from "../authorization";

export interface ConversationStore {
  append(
    space: string,
    agent: string,
    thread: string,
    messages: ModelMessage[]
  ): void;
  load(space: string, agent: string, thread: string): ModelMessage[];
}

const DEFAULT_THREAD = "main";

export function defaultThread(): string {
  return DEFAULT_THREAD;
}

export function createInMemoryConversationStore(): ConversationStore {
  const threads = new Map<string, ModelMessage[]>();
  const key = (space: string, agent: string, thread: string) =>
    `${space}-${agent}-${thread}`;

  return {
    append(space, agent, thread, messages) {
      if (messages.length === 0) {
        return;
      }
      const k = key(space, agent, thread);
      const prior = threads.get(k) ?? [];
      threads.set(k, [...prior, ...messages]);
    },
    load(space, agent, thread) {
      return threads.get(key(space, agent, thread)) ?? [];
    },
  };
}

export interface ToolContext {
  mesh?: ConversationStore;
  space?: string;
}

export interface ToolContextOptions {
  mesh?: ConversationStore;
  /**
   * The authority the calling harness is running under. Unlike everything
   * else here it never becomes a field on the context — see
   * {@link createToolContext}.
   */
  policy?: AgentAuthorizer;
  space?: string;
}

/**
 * Policy by context instance. The one thing a context carries that is *not*
 * part of its shape, for two reasons:
 *
 * 1. A host owns whatever it passes as `experimental_context` and may have
 *    frozen it, or branded it into a `WeakSet` so persisted or model-authored
 *    JSON can't forge a live capability (`@foundry/analyze` does both). There
 *    is nowhere on such an object to put anything.
 * 2. Everything else on a context is data a host composes by hand. A tool
 *    asking "what am I allowed to do" must not be answerable that way.
 *
 * Weak, so an entry dies with the turn's context and nothing has to evict.
 */
const policies = new WeakMap<object, AgentAuthorizer>();

/**
 * The tool context for one call.
 *
 * With a `base`, returns that **same object** — identity is the contract,
 * since the host may have frozen or branded it. Only `policy` is contributed
 * in that form; the rest of a context is the host's own shape to build and
 * reshape (dynamically loaded tools and MCP servers change what belongs on
 * it), so this never rewrites it.
 *
 * Without a `base`, mints a plain context from the data options.
 */
export function createToolContext<T extends object>(
  options: { policy: AgentAuthorizer },
  base: T
): T;
export function createToolContext(options?: ToolContextOptions): ToolContext;
export function createToolContext(
  options: ToolContextOptions = {},
  base?: object
): object {
  const context = base ?? { mesh: options.mesh, space: options.space };
  if (options.policy) {
    policies.set(context, options.policy);
  }
  return context;
}

export function getConversationStore(
  context: unknown
): ConversationStore | undefined {
  if (typeof context !== "object" || context === null) {
    return undefined;
  }
  return (context as ToolContext).mesh;
}

export function getSpace(context: unknown): string | undefined {
  if (typeof context !== "object" || context === null) {
    return undefined;
  }
  return (context as ToolContext).space;
}

/**
 * The policy the calling harness is running under — attached to every call by
 * `AgentHarness`. Absent when a tool runs outside a harness (a direct
 * `execute` in a test) or through a context that isn't an object. Never read
 * off a field, so no context can claim an authority it wasn't given.
 */
export function getPolicy(context: unknown): AgentAuthorizer | undefined {
  if (typeof context !== "object" || context === null) {
    return undefined;
  }
  return policies.get(context);
}
