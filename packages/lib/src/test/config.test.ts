import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { Config } from "../config/config";
import type { ConfigChangePayload } from "../config/types";

const QueueSchema = z.object({
  concurrency: z.number(),
  retryLimit: z.number().optional(),
});
type Queue = z.infer<typeof QueueSchema>;

const WorkspacesSchema = z.object({
  scan: z
    .object({
      maxDepth: z.number().optional(),
      skipDirs: z.array(z.string()).optional(),
    })
    .optional(),
  worktreesSubdir: z.string().optional(),
});
type Workspaces = z.infer<typeof WorkspacesSchema>;

function makeConfig() {
  const c = new Config();
  c.contribute<Queue>("queue", QueueSchema, { concurrency: 4 });
  c.contribute<Workspaces>("workspaces", WorkspacesSchema, {});
  return c;
}

describe("Config — contribution", () => {
  test("contribute registers a prefix and seeds defaults", () => {
    const c = new Config();
    c.contribute<Queue>("queue", QueueSchema, { concurrency: 4 });
    expect(c.contributed()).toEqual(["queue"]);
    expect(c.get("queue")).toEqual({ concurrency: 4 });
  });

  test("contribute throws on duplicate prefix", () => {
    const c = new Config();
    c.contribute<Queue>("queue", QueueSchema, { concurrency: 4 });
    expect(() => {
      c.contribute<Queue>("queue", QueueSchema, { concurrency: 4 });
    }).toThrow(/already contributed/);
  });

  test("contribute throws on dotted prefix (must be single segment)", () => {
    const c = new Config();
    expect(() => {
      c.contribute("queue.runner", QueueSchema, { concurrency: 4 });
    }).toThrow(/single segment/);
  });
});

describe("Config — read by dot-path or prefix", () => {
  test("get(prefix) returns the whole prefix object", () => {
    const c = makeConfig();
    expect(c.get("queue")).toEqual({ concurrency: 4 });
  });

  test("get(prefix.leaf) returns a nested leaf", () => {
    const c = makeConfig();
    c.set("workspaces.scan.maxDepth", 4);
    expect(c.get("workspaces.scan.maxDepth")).toBe(4);
  });

  test("get for an unknown prefix returns undefined", () => {
    const c = makeConfig();
    expect(c.get("missing")).toBeUndefined();
    expect(c.get("missing.x.y")).toBeUndefined();
  });

  test("snapshot() returns every prefix keyed by name", () => {
    const c = makeConfig();
    c.set("queue.concurrency", 8);
    expect(c.snapshot()).toEqual({
      queue: { concurrency: 8 },
      workspaces: {},
    });
  });
});

describe("Config — write by dot-path", () => {
  test("set(prefix, value) replaces the entire prefix", () => {
    const c = makeConfig();
    c.set("queue", { concurrency: 16, retryLimit: 2 });
    expect(c.get("queue")).toEqual({ concurrency: 16, retryLimit: 2 });
  });

  test("set(prefix.leaf, value) deep-sets and validates the whole prefix", () => {
    const c = makeConfig();
    c.set("workspaces.scan.maxDepth", 7);
    expect(c.get("workspaces")).toEqual({ scan: { maxDepth: 7 } });
  });

  test("set rejects on schema failure and leaves the ref untouched", () => {
    const c = makeConfig();
    const before = c.get("queue");
    expect(() => {
      c.set("queue.concurrency", "nope");
    }).toThrow();
    expect(c.get("queue")).toEqual(before);
  });

  test("set throws when the prefix isn't contributed", () => {
    const c = makeConfig();
    expect(() => {
      c.set("unknown.x", 1);
    }).toThrow(/not contributed/);
  });
});

describe("Config — merge (object form)", () => {
  test("merge groups keys by prefix and commits each atomically", () => {
    const c = makeConfig();
    c.merge({
      queue: { concurrency: 12 },
      workspaces: { scan: { maxDepth: 3 } },
    });
    expect(c.get("queue.concurrency")).toBe(12);
    expect(c.get("workspaces.scan.maxDepth")).toBe(3);
  });

  test("merge skips unknown prefixes with a warning, applies the rest", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const c = makeConfig();
    c.merge({
      bogus: { whatever: true },
      queue: { concurrency: 7 },
    });
    expect(c.get("queue.concurrency")).toBe(7);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('unknown prefix "bogus"')
    );
    warn.mockRestore();
  });

  test("merge does deep-merge within a prefix, not replace", () => {
    const c = makeConfig();
    c.set("workspaces", { scan: { maxDepth: 5, skipDirs: ["a"] } });
    c.merge({ workspaces: { scan: { skipDirs: ["b"] } } });
    expect(c.get("workspaces.scan.maxDepth")).toBe(5);
    expect(c.get("workspaces.scan.skipDirs")).toEqual(["b"]);
  });
});

describe("Config — reset", () => {
  test("reset(prefix) restores defaults for that prefix only", () => {
    const c = makeConfig();
    c.set("queue.concurrency", 99);
    c.set("workspaces.scan.maxDepth", 99);
    c.reset("queue");
    expect(c.get("queue.concurrency")).toBe(4);
    expect(c.get("workspaces.scan.maxDepth")).toBe(99);
  });

  test("reset() with no arg restores every prefix", () => {
    const c = makeConfig();
    c.set("queue.concurrency", 99);
    c.set("workspaces.scan.maxDepth", 99);
    c.reset();
    expect(c.get("queue")).toEqual({ concurrency: 4 });
    expect(c.get("workspaces")).toEqual({});
  });
});

describe("Config — events", () => {
  test("whole-prefix event fires once per atomic commit with full before/after", () => {
    const c = makeConfig();
    const seen: ConfigChangePayload[] = [];
    c.on("queue", (p: ConfigChangePayload) => seen.push(p));
    c.set("queue.concurrency", 8);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      after: { concurrency: 8 },
      before: { concurrency: 4 },
      path: "queue",
      source: "set",
    });
  });

  test("exact-key event fires for the leaf path that changed", () => {
    const c = makeConfig();
    const handler = vi.fn();
    c.on("queue.concurrency", handler);
    c.set("queue.concurrency", 8);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      after: 8,
      before: 4,
      path: "queue.concurrency",
    });
  });

  test("prefix-glob event fires once per leaf change", () => {
    const c = makeConfig();
    const seen: string[] = [];
    c.on("workspaces.*", (p: ConfigChangePayload) => seen.push(p.path));
    c.merge({
      workspaces: {
        scan: { maxDepth: 4 },
        worktreesSubdir: ".wt",
      },
    });
    expect(seen.sort()).toEqual([
      "workspaces.scan.maxDepth",
      "workspaces.worktreesSubdir",
    ]);
  });

  test("only the keys that actually changed fire leaf events", () => {
    const c = makeConfig();
    c.set("workspaces", {
      scan: { maxDepth: 4 },
      worktreesSubdir: ".wt",
    });
    const seen: string[] = [];
    c.on("workspaces.*", (p: ConfigChangePayload) => seen.push(p.path));
    c.merge({ workspaces: { scan: { maxDepth: 8 } } });
    expect(seen).toEqual(["workspaces.scan.maxDepth"]);
  });
});

describe("Config — atomicity", () => {
  test("sequential merges to disjoint keys both land", () => {
    const c = makeConfig();
    c.set("workspaces", { scan: { maxDepth: 0, skipDirs: [] } });
    c.merge({ workspaces: { scan: { maxDepth: 99 } } });
    c.merge({ workspaces: { scan: { skipDirs: ["x"] } } });
    expect(c.get("workspaces.scan")).toEqual({
      maxDepth: 99,
      skipDirs: ["x"],
    });
  });
});

describe("Config.loadFromData", () => {
  test("fans top-level keys into matching prefixes with 'load' source", () => {
    const c = makeConfig();
    const handler = vi.fn();
    c.on("queue", handler);
    const result = c.loadFromData({
      queue: { concurrency: 16 },
      workspaces: { scan: { maxDepth: 3 } },
    });
    expect(c.get("queue.concurrency")).toBe(16);
    expect(c.get("workspaces.scan.maxDepth")).toBe(3);
    expect([...result.applied].sort()).toEqual(["queue", "workspaces"]);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ source: "load" });
  });

  test("skips unknown prefixes with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const c = makeConfig();
    const result = c.loadFromData({
      bogus: { whatever: true },
      queue: { concurrency: 12 },
    });
    expect(c.get("queue.concurrency")).toBe(12);
    expect(result.applied).toEqual(["queue"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('unknown prefix "bogus"')
    );
    warn.mockRestore();
  });

  test("skips invalid prefix payload, keeps prior, applies siblings", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const c = makeConfig();
    const result = c.loadFromData({
      queue: { concurrency: "nope" },
      workspaces: { scan: { maxDepth: 9 } },
    });
    expect(c.get("queue")).toEqual({ concurrency: 4 });
    expect(c.get("workspaces.scan.maxDepth")).toBe(9);
    expect(result.applied).toEqual(["workspaces"]);
    warn.mockRestore();
  });

  test("emits 'loaded' with applied prefixes", () => {
    const c = makeConfig();
    const onLoaded = vi.fn();
    c.on("loaded", onLoaded);
    c.loadFromData({ queue: { concurrency: 8 } });
    expect(onLoaded).toHaveBeenCalledWith({ applied: ["queue"] });
  });
});
