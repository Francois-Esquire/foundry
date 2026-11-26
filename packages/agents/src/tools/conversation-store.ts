import type { ModelMessage } from "ai";

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

export function createMemoryConversationStore(): ConversationStore {
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
