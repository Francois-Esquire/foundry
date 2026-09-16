import { describe, expect, it } from "vitest";

import type { AgentAuthorizer } from "../../authorization";
import {
  createInMemoryConversationStore,
  createToolContext,
  getConversationStore,
  getPolicy,
  getSpace,
} from "../../tools/context";
import { fakeAuthorizer } from "../helpers/authorizer";

function fakePolicy(): AgentAuthorizer {
  return fakeAuthorizer(() => ({ kind: "allow", source: "grant" }));
}

describe("createToolContext (engine-free base)", () => {
  it("defaults to an empty context", () => {
    const ctx = createToolContext();
    expect(ctx.mesh).toBeUndefined();
    expect(ctx.space).toBeUndefined();
  });

  it("threads mesh + space through the options bag", () => {
    const mesh = createInMemoryConversationStore();
    const ctx = createToolContext({ mesh, space: "boot-1" });
    expect(ctx.mesh).toBe(mesh);
    expect(ctx.space).toBe("boot-1");
  });

  it("getConversationStore / getSpace read off an opaque tool context", () => {
    const mesh = createInMemoryConversationStore();
    const opaque: unknown = createToolContext({ mesh, space: "boot-9" });
    expect(getConversationStore(opaque)).toBe(mesh);
    expect(getSpace(opaque)).toBe("boot-9");

    const bare: unknown = createToolContext();
    expect(getConversationStore(bare)).toBeUndefined();
    expect(getSpace(bare)).toBeUndefined();
  });
});

describe("createToolContext — attaching a policy to a host's own context", () => {
  it("returns the caller's exact object, frozen or branded, never a copy", () => {
    // The shape `@foundry/analyze` uses: branded into a WeakSet and frozen, so
    // a copy fails its check and a write throws.
    const branded = new WeakSet();
    const base = Object.freeze({ engine: "the-engine" });
    branded.add(base);

    const context = createToolContext({ policy: fakePolicy() }, base);

    expect(context).toBe(base);
    expect(branded.has(context)).toBe(true);
    expect(Reflect.ownKeys(base)).toEqual(["engine"]);
  });

  it("leaves the host's own shape entirely alone — it owns what goes on it", () => {
    const mesh = createInMemoryConversationStore();
    const policy = fakePolicy();
    const base = { engine: "the-engine", mesh, space: "host-space" };

    const context: unknown = createToolContext({ policy }, base);

    expect((context as { engine: string }).engine).toBe("the-engine");
    expect(getConversationStore(context)).toBe(mesh);
    expect(getSpace(context)).toBe("host-space");
    expect(getPolicy(context)).toBe(policy);
  });

  it("tracks a context the host reshaped after the policy was attached", () => {
    // Dynamically loaded tools and MCP servers change what a context carries;
    // only `policy` is held outside the object, so the rest stays live.
    const policy = fakePolicy();
    const base: { space?: string } = {};
    createToolContext({ policy }, base);

    base.space = "boot-2";

    expect(getSpace(base)).toBe("boot-2");
    expect(getPolicy(base)).toBe(policy);
  });

  it("replaces the policy when the same context is used for another call", () => {
    const first = fakePolicy();
    const second = fakePolicy();
    const base = {};

    createToolContext({ policy: first }, base);
    createToolContext({ policy: second }, base);

    expect(getPolicy(base)).toBe(second);
  });
});

describe("getPolicy", () => {
  it("never honours a `policy` field — authority is never part of the shape", () => {
    // A context is data a host (or, one day, something it deserialized) can
    // compose; being handed one must not be a way to claim authority.
    const forged = { policy: fakePolicy() };
    expect(getPolicy(forged)).toBeUndefined();

    const real = fakePolicy();
    expect(getPolicy(createToolContext({ policy: real }, forged))).toBe(real);
  });

  it("reports absence for a context that never got one, or isn't an object", () => {
    expect(getPolicy({})).toBeUndefined();
    expect(getPolicy(undefined)).toBeUndefined();
    expect(getPolicy("opaque")).toBeUndefined();
  });
});
