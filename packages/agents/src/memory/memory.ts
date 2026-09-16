import { tool } from "ai";
import { z } from "zod";

import type { MemoryStore } from "./store";

import { InMemoryMemoryStore, MEMORY_TYPES } from "./store";

export const memoryTypeSchema = z.enum(MEMORY_TYPES);

export interface MemoryOptions {
  /**
   * Recover per-call provenance from the harness tool context
   * (`experimental_context`) — e.g. the resolved session id, which is only
   * known at turn time, not when the agent (and this instance) is built.
   */
  resolveSourceId?: (experimentalContext: unknown) => string | undefined;
  store?: MemoryStore;
}

/**
 * Agent memory over a {@link MemoryStore}. `tools()` builds the
 * `remember` / `recall` / `forget` AI SDK tools bound to this instance.
 */
export class Memory {
  readonly store: MemoryStore;
  readonly #resolveSourceId: MemoryOptions["resolveSourceId"];

  constructor(options: MemoryOptions = {}) {
    this.store = options.store ?? new InMemoryMemoryStore();
    this.#resolveSourceId = options.resolveSourceId;
  }

  tools() {
    const remember = tool({
      description:
        "Store a new memory. Use only for durable facts, preferences, decisions, or context the user has shared. Summarize first — do not dump raw conversation.",
      execute: async (input, { context }) => {
        const record = await this.store.create({
          content: input.content,
          sourceId: this.#resolveSourceId?.(context),
          summary: input.summary,
          tags: input.tags,
          type: input.type,
        });
        return {
          createdAt: record.createdAt,
          id: record.id,
          type: record.type,
        };
      },
      inputSchema: z.object({
        content: z
          .string()
          .min(1)
          .describe(
            "The memory content. Should be a concise, standalone statement."
          ),
        summary: z
          .string()
          .optional()
          .describe("Optional shorter summary used in recall previews."),
        tags: z
          .array(z.string())
          .optional()
          .describe("Free-form tags for filtering."),
        type: memoryTypeSchema.default("memory"),
      }),
    });

    const recall = tool({
      description:
        "Semantic search across stored memories. Returns ranked hits with id, content, type, score, and tags. Use before answering questions where prior context could help.",
      execute: async (input) => {
        const page = await this.store.search(input);
        return { hits: page.hits, truncated: page.truncated };
      },
      inputSchema: z.object({
        limit: z.number().int().min(1).max(20).default(8),
        query: z.string().min(1).describe("Natural-language search query"),
        type: memoryTypeSchema
          .optional()
          .describe("Restrict to a single memory type"),
      }),
    });

    const forget = tool({
      description:
        "Delete a memory by id. Use when the user asks to remove specific information or after recalling something clearly outdated.",
      execute: async (input) => {
        await this.store.delete(input.id);
        return { deleted: true, id: input.id };
      },
      inputSchema: z.object({
        id: z.string().min(1),
      }),
    });

    return { forget, recall, remember };
  }
}
