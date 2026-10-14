import type { Store } from "@deps/contract";

import { makeAdapter } from "@deps/contract/adapter";

export class MemoryStore implements Store {
  private readonly entries = new Map<string, string>();

  get(key: string): string | undefined {
    return this.entries.get(key);
  }
}

export const adapter = makeAdapter(new MemoryStore());
