import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { AgentAuthorizer } from "../../authorization/authorization";
import { agentSubject } from "../../authorization/authorization";
import { AgentHarness } from "../../harness/agent-harness";
import { SessionHarness } from "../../harness/session-harness";
import type { SessionEvent } from "../../session/events";
import { InMemorySessionStore } from "../../session/store";
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
    const harness = new AgentHarness({
      instructions: "x",
      model: createScriptedMockModel({}),
      policy,
    });

    expect(harness.policy).toBe(policy);
  });

  it("falls back to a real policy — never undefined — when none is configured", async () => {
    const harness = new AgentHarness({
      instructions: "x",
      model: createScriptedMockModel({}),
    });

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
    const harness = new AgentHarness({
      instructions: "x",
      model: probingModel(),
      policy,
      tools,
    });

    const { parts } = await harness.stream({ prompt: "hi" });
    await drainGeneric(parts);

    expect(getPolicy(seen.context)).toBe(policy);
  });

  it("hands the tool the caller's own context object, unchanged, with the policy reachable", async () => {
    const policy = allowPolicy();
    const { tools, seen } = contextCapturingTool();
    const callerContext = { db: "the-db", sessionId: "s1" };
    const harness = new AgentHarness({
      instructions: "x",
      model: probingModel(),
      policy,
      tools,
      toolsContext: callerContext,
    });

    const { parts } = await harness.stream({ prompt: "hi" });
    await drainGeneric(parts);

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
    const harness = new AgentHarness({
      instructions: "x",
      model: probingModel(),
      policy,
      tools,
      toolsContext: callerContext,
    });

    const { parts } = await harness.stream({ prompt: "hi" });
    await drainGeneric(parts);

    expect(branded.has(seen.context as object)).toBe(true);
    expect(getPolicy(seen.context)).toBe(policy);
  });

  it("never writes a property onto the caller's context object", async () => {
    const { tools, seen } = contextCapturingTool();
    const callerContext = { db: "the-db" };
    const harness = new AgentHarness({
      instructions: "x",
      model: probingModel(),
      policy: allowPolicy(),
      tools,
      toolsContext: callerContext,
    });

    const { parts } = await harness.stream({ prompt: "hi" });
    await drainGeneric(parts);

    expect(Reflect.ownKeys(callerContext)).toEqual(["db"]);
    expect(seen.context).toBe(callerContext);
  });
});

describe("SessionHarness — policy", () => {
  it("runs under the same policy instance as the agent harness it wraps", () => {
    const policy = allowPolicy();
    const harness = new SessionHarness({
      instructions: "x",
      model: createScriptedMockModel({}),
      policy,
      sessionId: "s1",
      store: new InMemorySessionStore(),
    });

    expect(harness.policy).toBe(policy);
  });

  it("hands every turn's tools the caller's own context object, with the policy attached", async () => {
    const policy = allowPolicy();
    const { tools, seen } = contextCapturingTool();
    const callerContext = { db: "the-db", sessionId: "s1" };
    const harness = new SessionHarness({
      instructions: "x",
      model: probingModel(),
      policy,
      sessionId: "s1",
      store: new InMemorySessionStore(),
      tools,
      toolsContext: callerContext,
    });

    await drain(harness.stream("hi"));

    expect(seen.context).toBe(callerContext);
    expect(getPolicy(seen.context)).toBe(policy);
  });

  it("attaches it on a session turn that configures no tool context at all", async () => {
    const policy = allowPolicy();
    const { tools, seen } = contextCapturingTool();
    const harness = new SessionHarness({
      instructions: "x",
      model: probingModel(),
      policy,
      sessionId: "s1",
      store: new InMemorySessionStore(),
      tools,
    });

    await drain(harness.stream("hi"));

    expect(getPolicy(seen.context)).toBe(policy);
  });
});
