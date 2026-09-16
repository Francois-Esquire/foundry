/**
 * Mount mechanics — child-owned config nodes bound into a parent under a
 * prefix (Model A: no copy, child owns storage + validation, parent delegates
 * and forwards). Covers the delegation surface (every whole-store method must
 * be mount-aware), event forwarding (source preserved, parent "changed",
 * detach kills the relay), and the conflict/re-mount policy.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Config } from "../config/config";
import { ReactiveStore } from "../config/reactive-store";
import type { ConfigChangePayload } from "../config/types";

const BlockSchema = z.object({ label: z.string(), n: z.number() });
const BLOCK_DEFAULTS = { label: "x", n: 0 };

/** A child config node with its own schema (mimics a domain config). */
function makeChild(): Config {
  const c = new Config();
  c.contribute("block", BlockSchema, BLOCK_DEFAULTS);
  return c;
}

/** A parent with one contributed (parent-owned) slice for collision tests. */
function makeParent(): Config {
  const p = new Config();
  p.contribute("queue", z.object({ concurrency: z.number() }), {
    concurrency: 1,
  });
  return p;
}

describe("mount — read/write delegation", () => {
  it("delegates nested reads and whole-prefix reads to the child", () => {
    const parent = makeParent();
    const child = makeChild();
    child.set("block.n", 5);
    parent.mount("models", child);

    expect(parent.get("models.block.n")).toBe(5);
    expect(parent.get("models.block")).toEqual({ label: "x", n: 5 });
    expect(parent.get("models")).toEqual({ block: { label: "x", n: 5 } });
  });

  it("delegates writes to the child, which validates against its own schema", () => {
    const parent = makeParent();
    const child = makeChild();
    parent.mount("models", child);

    parent.set("models.block.n", 9);
    expect(child.get("block.n")).toBe(9);

    // Child owns validation — a bad write throws via the child's schema.
    expect(() => {
      parent.set("models.block.n", "nope");
    }).toThrow();
    expect(child.get("block.n")).toBe(9); // unchanged
  });

  it("refuses to set the whole mounted prefix (ambiguous — re-mount instead)", () => {
    const parent = makeParent();
    parent.mount("models", makeChild());
    expect(() => {
      parent.set("models", { block: { n: 1 } });
    }).toThrow(/whole mounted prefix/);
  });

  it("leaves contributed prefixes working alongside mounts", () => {
    const parent = makeParent();
    parent.mount("models", makeChild());
    parent.set("queue.concurrency", 4);
    expect(parent.get("queue.concurrency")).toBe(4);
  });
});

describe("mount — whole-store methods are mount-aware", () => {
  it("merge() routes a mounted prefix to the child instead of warning+dropping", () => {
    const parent = makeParent();
    const child = makeChild();
    parent.mount("models", child);

    parent.merge({ models: { block: { n: 3 } }, queue: { concurrency: 7 } });
    expect(child.get("block.n")).toBe(3);
    expect(parent.get("queue.concurrency")).toBe(7);
  });

  it("loadFromData() routes a mounted prefix to the child and reports it applied", () => {
    const parent = makeParent();
    const child = makeChild();
    parent.mount("models", child);

    const result = parent.loadFromData({ models: { block: { n: 11 } } });
    expect(child.get("block.n")).toBe(11);
    expect([...result.applied].sort()).toEqual(["models"]);
  });

  it("snapshot() includes mounted children from their live values", () => {
    const parent = makeParent();
    const child = makeChild();
    child.set("block.n", 6);
    parent.mount("models", child);

    expect(parent.snapshot()).toEqual({
      models: { block: { label: "x", n: 6 } },
      queue: { concurrency: 1 },
    });
  });

  it("contributed() lists both contributed and mounted prefixes", () => {
    const parent = makeParent();
    parent.mount("models", makeChild());
    expect([...parent.contributed()].sort()).toEqual(["models", "queue"]);
  });

  it("reset(prefix) delegates to the child; bare reset() leaves children untouched", () => {
    const parent = makeParent();
    const child = makeChild();
    parent.mount("models", child);
    parent.set("models.block.n", 42);
    parent.set("queue.concurrency", 9);

    parent.reset(); // contributed only
    expect(parent.get("queue.concurrency")).toBe(1);
    expect(child.get("block.n")).toBe(42); // child untouched

    parent.reset("models"); // delegates to child
    expect(child.get("block.n")).toBe(0);
  });
});

describe("mount — event forwarding", () => {
  it("re-emits child commits under the prefix (leaf, glob, whole-prefix)", () => {
    const parent = makeParent();
    const child = makeChild();
    parent.mount("models", child);

    const leaf = vi.fn();
    const glob = vi.fn();
    const whole = vi.fn();
    parent.on("models.block.n", leaf);
    parent.on("models.*", glob);
    parent.on("models", whole);

    child.set("block.n", 1); // mutate the child directly

    expect(leaf).toHaveBeenCalledTimes(1);
    expect(glob).toHaveBeenCalledTimes(1);
    expect(whole).toHaveBeenCalledTimes(1);
    expect(
      (leaf.mock.calls[0]?.[0] as ConfigChangePayload | undefined)?.path
    ).toBe("models.block.n");
  });

  it("fires parent 'changed' with an assembled whole-store view", () => {
    const parent = makeParent();
    const child = makeChild();
    parent.mount("models", child);

    const changed = vi.fn();
    parent.on("changed", changed);
    parent.set("models.block.n", 2);

    expect(changed).toHaveBeenCalledTimes(1);
    const [after, before] = changed.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(after.models).toEqual({ block: { label: "x", n: 2 } });
    expect(after.queue).toEqual({ concurrency: 1 }); // contributed sibling present
    expect(before.models).toEqual({ block: { label: "x", n: 0 } });
  });

  it("preserves the child's source on forwarded events (not re-stamped)", () => {
    const parent = makeParent();
    const child = makeChild();
    parent.mount("models", child);

    const seen: ConfigChangePayload[] = [];
    parent.on("models.block.n", (p: ConfigChangePayload) => seen.push(p));

    child.merge({ block: { n: 4 } }); // child source = "merge"
    child.loadFromData({ block: { label: "y", n: 5 } }); // child source = "load"

    expect(seen.map((p) => p.source)).toEqual(["merge", "load"]);
  });

  it("forwards from a plain ReactiveStore child (source defaults to 'set')", () => {
    const parent = makeParent();
    const child = new ReactiveStore<Record<string, unknown>>({ a: { b: 1 } });
    parent.mount("plain", child);

    const seen: ConfigChangePayload[] = [];
    parent.on("plain.a.b", (p: ConfigChangePayload) => seen.push(p));
    child.set("a.b", 2);

    expect(parent.get("plain.a.b")).toBe(2);
    expect(seen[0]?.source).toBe("set");
  });
});

describe("mount — conflict / re-mount policy", () => {
  it("is a no-op when the same instance is mounted again (no warn)", () => {
    const parent = makeParent();
    const child = makeChild();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    parent.mount("models", child);
    parent.mount("models", child);

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns and overrides when a different child takes an occupied prefix", () => {
    const parent = makeParent();
    const oldChild = makeChild();
    const newChild = makeChild();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    parent.mount("models", oldChild);
    parent.mount("models", newChild);

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();

    // New child is live; old child is detached but still alive.
    const seen = vi.fn();
    parent.on("models.block.n", seen);
    newChild.set("block.n", 1);
    expect(seen).toHaveBeenCalledTimes(1);

    oldChild.set("block.n", 99); // detached — must NOT fire on the parent
    expect(seen).toHaveBeenCalledTimes(1);
    expect(oldChild.get("block.n")).toBe(99); // old child fully intact
  });

  it("throws on mount over a contributed prefix, and contribute over a mount", () => {
    const parent = makeParent();
    expect(() => {
      parent.mount("queue", makeChild());
    }).toThrow(/already contributed/);

    parent.mount("models", makeChild());
    expect(() => {
      parent.contribute("models", z.object({}), {});
    }).toThrow(/already mounted/);
  });
});

describe("detach", () => {
  it("severs forwarding and the parent stops resolving the prefix; child survives", () => {
    const parent = makeParent();
    const child = makeChild();
    parent.mount("models", child);
    parent.set("models.block.n", 7);

    const seen = vi.fn();
    parent.on("models.block.n", seen);

    parent.detach("models");

    child.set("block.n", 8); // no longer forwarded
    expect(seen).not.toHaveBeenCalled();
    expect(parent.get("models.block.n")).toBeUndefined(); // not contributed
    expect(child.get("block.n")).toBe(8); // child intact
  });

  it("is a no-op for an unmounted prefix", () => {
    const parent = makeParent();
    expect(() => {
      parent.detach("nope");
    }).not.toThrow();
  });
});
