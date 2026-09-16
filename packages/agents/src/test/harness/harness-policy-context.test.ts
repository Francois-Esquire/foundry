import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { AgentAuthorizer } from "../../authorization";
import { agentSubject } from "../../authorization";
import { AgentHarness, SessionHarness } from "../../harness";
import type { SessionEvent } from "../../session";
import { InMemorySessionStore } from "../../session";
import { getPolicy } from "../../tools/context";
import { fakeAuthorizer } from "../helpers/authorizer";
import {
  createScriptedMockModel,
  textStreamResult,
  toolCallStreamResult,
} from "../helpers/mock-language-model";

/** Allow everything; identity is what these tests assert on, not behaviour. */
function allowPolicy(): AgentAuthorizer {
  return fakeAuthorizer(() => ({ kind: "allow", source: "grant" }));
}

/** A tool that records the `experimental_context` its `execute` was handed. */
function contextCapturingTool() {
  const seen: { context?: unknown } = {};
  return {
    seen,
    tools: {
      probe: tool({
        contextSchema: z.custom<Record<string, unknown>>(),
        description: "records its tool context",
        execute: (_input, { context }) => {
          seen.context = context;
          return "ok";
        },
        inputSchema: z.object({}),
      }),
    },
  };
}

function probingModel() {
  return createScriptedMockModel({
    stream: [
      toolCallStreamResult("call-1", "probe", {}),
      textStreamResult("done"),
    ],
  });
}

async function drainGeneric(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of stream) {
    // exhaust
  }
}

async function drain(stream: AsyncIterable<SessionEvent>): Promise<void> {
  for await (const _event of stream) {
    // exhaust
  }
}

describe("AgentHarness.policy", () => {
  it("exposes the configured policy as the same instance the tools are gated by", () => {
    const policy = allowPolicy();
    const harness = new AgentHarness(
      { instructions: "x", model: createScriptedMockModel({}), policy },
      { sessionId: "" }
    );

    expect(harness.policy).toBe(policy);
  });

  it("falls back to a real policy — never undefined — when none is configured", async () => {
    const harness = new AgentHarness(
      { instructions: "x", model: createScriptedMockModel({}) },
      { sessionId: "" }
    );

    await expect(
      harness.policy.decide({
        capability: { kind: "tool.call", source: "declared", tool: "probe" },
        invocationId: "probe-1",
        subject: agentSubject("agent"),
      })
    ).resolves.toMatchObject({ kind: "allow" });
  });
});

describe("AgentHarness — policy on the tool context", () => {
  it("attaches the harness policy to a tool call that had no caller context", async () => {
    const policy = allowPolicy();
    const { tools, seen } = contextCapturingTool();
    const harness = new AgentHarness(
      { instructions: "x", model: probingModel(), policy, tools },
      { sessionId: "" }
    );

    const result = await harness.stream({ prompt: "hi" });
    await drainGeneric(result.stream);

    expect(getPolicy(seen.context)).toBe(policy);
  });

  it("hands the tool the caller's own context object, unchanged, with the policy reachable", async () => {
    const policy = allowPolicy();
    const { tools, seen } = contextCapturingTool();
    const callerContext = { db: "the-db", sessionId: "s1" };
    const harness = new AgentHarness(
      {
        instructions: "x",
        model: probingModel(),
        policy,
        tools,
        toolsContext: callerContext,
      },
      { sessionId: "" }
    );

    const result = await harness.stream({ prompt: "hi" });
    await drainGeneric(result.stream);

    // Identity, not shape: a copy would be a different object.
    expect(seen.context).toBe(callerContext);
    expect(getPolicy(seen.context)).toBe(policy);
  });

  it("preserves a frozen, WeakSet-branded context — the shape hosts actually use", async () => {
    // `@foundry/analyze` brands its analysis context this way and rejects any
    // context it did not itself mint, so binding a policy must not copy it.
    const branded = new WeakSet();
    const callerContext = Object.freeze({ db: "the-db" });
    branded.add(callerContext);

    const policy = allowPolicy();
    const { tools, seen } = contextCapturingTool();
    const harness = new AgentHarness(
      {
        instructions: "x",
        model: probingModel(),
        policy,
        tools,
        toolsContext: callerContext,
      },
      { sessionId: "" }
    );

    const result = await harness.stream({ prompt: "hi" });
    await drainGeneric(result.stream);

    expect(branded.has(seen.context as object)).toBe(true);
    expect(getPolicy(seen.context)).toBe(policy);
  });

  it("never writes a property onto the caller's context object", async () => {
    const { tools, seen } = contextCapturingTool();
    const callerContext = { db: "the-db" };
    const harness = new AgentHarness(
      {
        instructions: "x",
        model: probingModel(),
        policy: allowPolicy(),
        tools,
        toolsContext: callerContext,
      },
      { sessionId: "" }
    );

    const result = await harness.stream({ prompt: "hi" });
    await drainGeneric(result.stream);

    expect(Reflect.ownKeys(callerContext)).toEqual(["db"]);
    expect(seen.context).toBe(callerContext);
  });
});

describe("SessionHarness — inherited policy", () => {
  it("runs under the same policy instance as the agent harness it extends", () => {
    const policy = allowPolicy();
    const harness = new SessionHarness(
      {
        instructions: "x",
        model: createScriptedMockModel({}),
        policy,
        sessionId: "s1",
        store: new InMemorySessionStore(),
      },
      { sessionId: "s1" }
    );

    expect(harness).toBeInstanceOf(AgentHarness);
    expect(harness.policy).toBe(policy);
  });

  it("attaches it to the per-turn tool context built by `toolContext`", async () => {
    const policy = allowPolicy();
    const { tools, seen } = contextCapturingTool();
    const harness = new SessionHarness(
      {
        instructions: "x",
        model: probingModel(),
        policy,
        sessionId: "s1",
        store: new InMemorySessionStore(),
        toolContext: (sessionId) => ({ db: "the-db", sessionId }),
        tools,
      },
      { sessionId: "s1" }
    );

    await drain(harness.stream("hi"));

    // The session's own resolved context survives, and the policy rides with it.
    expect(seen.context).toMatchObject({ db: "the-db", sessionId: "s1" });
    expect(getPolicy(seen.context)).toBe(policy);
  });

  it("attaches it on a session turn that configures no `toolContext` at all", async () => {
    const policy = allowPolicy();
    const { tools, seen } = contextCapturingTool();
    const harness = new SessionHarness(
      {
        instructions: "x",
        model: probingModel(),
        policy,
        sessionId: "s1",
        store: new InMemorySessionStore(),
        tools,
      },
      { sessionId: "s1" }
    );

    await drain(harness.stream("hi"));

    expect(getPolicy(seen.context)).toBe(policy);
  });
});
