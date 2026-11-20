import type { ModelMessage } from "ai";

import type { AgentAuthorizer } from "../authorization/authorization";

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
    JSON.stringify([space, agent, thread]);

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
  conversations?: ConversationStore;
  space?: string;
}

export interface ToolContextOptions {
  conversations?: ConversationStore;
  policy?: AgentAuthorizer;
  space?: string;
}

const policies = new WeakMap<object, AgentAuthorizer>();

export function createToolContext<T extends object>(
  options: { policy: AgentAuthorizer },
  base: T
): T;
export function createToolContext(options?: ToolContextOptions): ToolContext;
export function createToolContext(
  options: ToolContextOptions = {},
  base?: object
): object {
  const context = base ?? mintToolContext(options);
  if (options.policy) {
    policies.set(context, options.policy);
  }
  return context;
}

function mintToolContext(options: ToolContextOptions): ToolContext {
  const context: ToolContext = {};
  if (options.conversations !== undefined) {
    context.conversations = options.conversations;
  }
  if (options.space !== undefined) {
    context.space = options.space;
  }
  return context;
}

export function getConversationStore(
  context: unknown
): ConversationStore | undefined {
  if (typeof context !== "object" || context === null) {
    return undefined;
  }
  return (context as ToolContext).conversations;
}

export function getSpace(context: unknown): string | undefined {
  if (typeof context !== "object" || context === null) {
    return undefined;
  }
  return (context as ToolContext).space;
}

export function getPolicy(context: unknown): AgentAuthorizer | undefined {
  if (typeof context !== "object" || context === null) {
    return undefined;
  }
  return policies.get(context);
}
