import { generateId } from "ai";

export const MEMORY_TYPES = ["memory", "note", "artifact", "fact"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface CreateMemoryInput {
  content: string;
  sourceId?: string;
  summary?: string;
  tags?: string[];
  type?: MemoryType;
}

export interface MemoryRecord {
  content: string;
  createdAt: string;
  id: string;
  summary: string | null;
  tags: string[];
  type: MemoryType;
}

export interface SearchMemoryInput {
  limit?: number;
  query: string;
  type?: MemoryType;
}

export interface MemoryHit extends MemoryRecord {
  score: number;
}

export interface MemorySearchPage {
  hits: MemoryHit[];
  truncated: boolean;
}

/**
 * The persistence seam for agent memory. A {@link Memory} is built on a
 * `MemoryStore` and never names a concrete database — swap in a db-backed
 * implementation (`createNodesMemoryStore` in the host's db package) to
 * persist memories; the default {@link InMemoryMemoryStore} keeps everything
 * in process.
 */
export interface MemoryStore {
  create(input: CreateMemoryInput): Promise<MemoryRecord>;
  delete(id: string): Promise<void>;
  search(input: SearchMemoryInput): Promise<MemorySearchPage>;
}

const DEFAULT_SEARCH_LIMIT = 10;

/**
 * Default, dependency-free store. Has no embedder, so `search` matches the
 * db-backed store's embedder-less fallback: a case-insensitive keyword match
 * over content, newest first, score 1.
 */
export class InMemoryMemoryStore implements MemoryStore {
  #rows: MemoryRecord[] = [];

  create(input: CreateMemoryInput): Promise<MemoryRecord> {
    const record: MemoryRecord = {
      content: input.content,
      createdAt: new Date().toISOString(),
      id: generateId(),
      summary: input.summary ?? null,
      tags: input.tags ?? [],
      type: input.type ?? "memory",
    };
    this.#rows.push(record);
    return Promise.resolve({ ...record });
  }

  search(input: SearchMemoryInput): Promise<MemorySearchPage> {
    const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
    const needle = input.query.toLowerCase();
    const hits = this.#rows
      .filter((row) => input.type === undefined || row.type === input.type)
      .filter((row) => row.content.toLowerCase().includes(needle))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((row) => ({ ...row, score: 1, tags: [...row.tags] }));
    return Promise.resolve({ hits, truncated: false });
  }

  delete(id: string): Promise<void> {
    this.#rows = this.#rows.filter((row) => row.id !== id);
    return Promise.resolve();
  }
}
