import { describe, expect, it } from "vitest";

import { Memory } from "../../memory/memory";
import { InMemoryMemoryStore } from "../../memory/store";

describe("InMemoryMemoryStore", () => {
  it("creates records with defaults and finds them by keyword", async () => {
    const store = new InMemoryMemoryStore();
    const created = await store.create({ content: "user prefers vitest" });
    expect(created.type).toBe("memory");
    expect(created.tags).toEqual([]);

    const page = await store.search({ query: "VITEST" });
    expect(page.hits.map((h) => h.id)).toEqual([created.id]);
    expect(page.hits[0]?.score).toBe(1);
    expect(page.truncated).toBe(false);

    const miss = await store.search({ query: "unrelated" });
    expect(miss.hits).toEqual([]);
  });

  it("filters by type and honors limit", async () => {
    const store = new InMemoryMemoryStore();
    await store.create({ content: "alpha fact", type: "fact" });
    await store.create({ content: "alpha note", type: "note" });
    await store.create({ content: "alpha note two", type: "note" });

    const facts = await store.search({ query: "alpha", type: "fact" });
    expect(facts.hits.map((h) => h.content)).toEqual(["alpha fact"]);

    const limited = await store.search({ limit: 2, query: "alpha" });
    expect(limited.hits).toHaveLength(2);
  });

  it("deletes by id", async () => {
    const store = new InMemoryMemoryStore();
    const created = await store.create({ content: "temp" });
    await store.delete(created.id);
    const page = await store.search({ query: "temp" });
    expect(page.hits).toEqual([]);
  });
});

describe("Memory", () => {
  it("defaults to an in-memory store and exposes the tool trio", () => {
    const memory = new Memory();
    const tools = memory.tools();
    expect(Object.keys(tools).sort()).toEqual(["forget", "recall", "remember"]);
  });

  it("threads resolved provenance into create", async () => {
    const seen: (string | undefined)[] = [];
    const store = new InMemoryMemoryStore();
    const create = store.create.bind(store);
    store.create = (input) => {
      seen.push(input.sourceId);
      return create(input);
    };

    const memory = new Memory({
      resolveSourceId: (ctx) => (ctx as { sessionId: string }).sessionId,
      store,
    });
    await memory.store.create({ content: "direct", sourceId: "explicit" });
    expect(seen).toEqual(["explicit"]);
  });
});
