import type { Tool, ToolExecutionOptions } from "ai";

import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { CommandAuthorityDefinition } from "../../authorization";
import {
  classifyCommandCapability,
  createInMemoryAgentAuthorizer,
} from "../../authorization";
import { directToolEffectPort } from "../../harness/effect-port";
import {
  compileRegistrations,
  compileTool,
  compileTools,
  withToolCallRegistration,
} from "../../harness/tool-compiler";
import type {
  HarnessToolRegistration,
  RegisteredToolCall,
  ToolEffectPort,
} from "../../harness/types";
import { registrationsOf, tagTool } from "../../harness/types";
import { fakeAuthorizer as fakePolicy } from "../helpers/authorizer";

/** Minimal `ToolExecutionOptions<unknown>`-shaped call for exercising a compiled tool directly. */
function callOptions(
  toolCallId: string,
  extra: Record<string, unknown> = {}
): {
  toolCallId: string;
  messages: [];
  context: unknown;
  [key: string]: unknown;
} {
  return { context: undefined, messages: [], toolCallId, ...extra };
}

/** Every compiled tool's `needsApproval` is always a function — cast past
 *  the AI SDK's `boolean | function` union for direct-call tests. */
function needsApproval(
  compiled: Tool,
  input: unknown,
  options: { toolCallId: string; messages: unknown[]; context?: unknown }
): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- ai v7 moves tool approval to the call level; the harness still owns approval today (deferred migration)
  const fn = compiled.needsApproval as (
    input: unknown,
    options: unknown
  ) => Promise<boolean>;
  return fn(input, options);
}

function fakeEffectPort(): {
  port: ToolEffectPort;
  calls: RegisteredToolCall[];
} {
  const calls: RegisteredToolCall[] = [];
  return {
    calls,
    port: {
      execute(invocation, effect) {
        calls.push(invocation);
        return effect();
      },
    },
  };
}

/** A single-input `{x: number}` tool registration, parameterized by `execute`
 *  so each test can plug in its own behavior. */
function registrationFor(
  execute: (
    input: { x: number },
    options: ToolExecutionOptions<unknown>
  ) => unknown
): HarnessToolRegistration {
  return {
    capability: () => ({
      kind: "tool.call",
      source: "declared",
      tool: "double",
    }),
    name: "double",
    source: "declared",
    tool: tool({
      description: "doubles a number",
      execute,
      inputSchema: z.object({ x: z.number() }),
    }),
  };
}

describe("tool-compiler — compileTool", () => {
  it("allow: executes through the effect port exactly once", async () => {
    const execute = vi.fn(({ x }: { x: number }) => x * 2);
    const registration = registrationFor(execute);
    const { port, calls } = fakeEffectPort();

    const compiled = compileTool(registration, {
      agentId: "a1",
      effectPort: port,
      policy: fakePolicy(() => ({ kind: "allow", source: "grant" })),
    });

    const result: unknown = await compiled.execute?.(
      { x: 2 },
      callOptions("call-1")
    );

    expect(result).toBe(4);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      toolCallId: "call-1",
      toolName: "double",
    });
  });

  it("streaming tool: the compiled execute is itself a generator that yields interim results through one effect", async () => {
    const execute = vi.fn(async function* ({ x }: { x: number }) {
      yield x;
      await Promise.resolve();
      yield x * 2;
    });
    const registration = registrationFor(execute);
    const { port, calls } = fakeEffectPort();
    const compiled = compileTool(registration, {
      agentId: "a1",
      effectPort: port,
      policy: fakePolicy(() => ({ kind: "allow", source: "grant" })),
    });

    // What the AI SDK checks: a synchronous async-iterable return, not a Promise.
    const result = compiled.execute?.({ x: 2 }, callOptions("c1")) as
      | AsyncIterable<unknown>
      | undefined;
    if (!(result && Symbol.asyncIterator in result)) {
      throw new Error("expected an async iterable");
    }
    const yielded: unknown[] = [];
    for await (const item of result) {
      yielded.push(item);
    }

    expect(yielded).toEqual([2, 4]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it("streaming tool: a denial is yielded once and the original never runs", async () => {
    const execute = vi.fn(async function* () {
      await Promise.resolve();
      yield "should not run";
    });
    const compiled = compileTool(registrationFor(execute), {
      agentId: "a1",
      effectPort: directToolEffectPort,
      policy: fakePolicy(() => ({
        kind: "deny",
        reason: "nope",
        source: "policy",
      })),
    });
    const result = compiled.execute?.(
      { x: 1 },
      callOptions("c1")
    ) as AsyncIterable<unknown>;
    const yielded: unknown[] = [];
    for await (const item of result) {
      yielded.push(item);
    }

    expect(yielded).toEqual([{ approved: false, reason: "nope" }]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("deny: returns a deterministic denial without executing", async () => {
    const execute = vi.fn(() => "should not run");
    const registration = registrationFor(execute);

    const compiled = compileTool(registration, {
      agentId: "a1",
      effectPort: directToolEffectPort,
      policy: fakePolicy(() => ({
        kind: "deny",
        reason: "nope",
        source: "policy",
      })),
    });

    const result: unknown = await compiled.execute?.(
      { x: 2 },
      callOptions("c1")
    );

    expect(result).toEqual({ approved: false, reason: "nope" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("approval-required: needsApproval reports true, and a defensive execute still denies", async () => {
    const execute = vi.fn(() => "should not run");
    const registration = registrationFor(execute);

    const compiled = compileTool(registration, {
      agentId: "a1",
      effectPort: directToolEffectPort,
      policy: fakePolicy(() => ({ kind: "requires-approval" })),
    });

    const needs = await needsApproval(compiled, { x: 1 }, callOptions("c1"));
    expect(needs).toBe(true);

    // Defensive path: unreachable in the real tool loop (the SDK never calls
    // `execute` once `needsApproval` says true), but must still deny rather
    // than run the effect if it somehow is.
    const result: unknown = await compiled.execute?.(
      { x: 1 },
      callOptions("c1")
    );
    expect(result).toMatchObject({ approved: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it("approved replay executes once while live policy still requires approval", async () => {
    const execute = vi.fn(() => "ran");
    const registration = registrationFor(execute);
    const compiled = compileTool(registration, {
      agentId: "a1",
      effectPort: directToolEffectPort,
      policy: fakePolicy(() => ({ kind: "requires-approval" })),
    });
    const messages = [
      {
        content: [
          {
            approvalId: "approval-c1",
            toolCallId: "c1",
            type: "tool-approval-request" as const,
          },
        ],
        role: "assistant" as const,
      },
      {
        content: [
          {
            approvalId: "approval-c1",
            approved: true,
            type: "tool-approval-response" as const,
          },
        ],
        role: "tool" as const,
      },
    ];

    const result: unknown = await compiled.execute?.(
      { x: 1 },
      { context: undefined, messages, toolCallId: "c1" }
    );

    expect(result).toBe("ran");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("sticky: needsApproval stays true once a request exists in history, even if live policy now allows", async () => {
    const registration = registrationFor(() => "ran");
    const compiled = compileTool(registration, {
      agentId: "a1",
      effectPort: directToolEffectPort,
      policy: fakePolicy(() => ({ kind: "allow", source: "grant" })),
    });

    const messages = [
      {
        content: [
          {
            approvalId: "appr-1",
            toolCallId: "c1",
            type: "tool-approval-request",
          },
        ],
        role: "assistant",
      },
    ];

    const needs = await needsApproval(
      compiled,
      { x: 1 },
      { context: undefined, messages, toolCallId: "c1" }
    );
    expect(needs).toBe(true);
  });

  it("preserves an existing needsApproval predicate alongside the policy decision", async () => {
    const original = tool({
      description: "always wants a human",
      execute: () => "ran",
      inputSchema: z.object({ x: z.number() }),
      needsApproval: true,
    });
    const registration: HarnessToolRegistration = {
      capability: () => ({
        kind: "tool.call",
        source: "declared",
        tool: "always-ask",
      }),
      name: "always-ask",
      source: "declared",
      tool: original,
    };

    const compiled = compileTool(registration, {
      agentId: "a1",
      effectPort: directToolEffectPort,
      policy: fakePolicy(() => ({ kind: "allow", source: "grant" })),
    });

    const needs = await needsApproval(compiled, { x: 1 }, callOptions("c1"));
    expect(needs).toBe(true);
  });

  it("revoked continuation: execute re-authorizes against the current policy and denies", async () => {
    const execute = vi.fn(() => "should not run");
    const registration = registrationFor(execute);

    let mode: "allow" | "deny" = "allow";
    const policy = fakePolicy(() =>
      mode === "allow"
        ? { kind: "allow", source: "grant" }
        : { kind: "deny", reason: "revoked", source: "policy" }
    );
    const compiled = compileTool(registration, {
      agentId: "a1",
      effectPort: directToolEffectPort,
      policy,
    });

    // The grant is revoked between the human's approval and the continuation
    // actually reaching `execute` — the live re-check must win.
    mode = "deny";
    const result: unknown = await compiled.execute?.(
      { x: 1 },
      callOptions("c1")
    );

    expect(result).toEqual({ approved: false, reason: "revoked" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("a thrown effect propagates as a rejection, not a silent denial", async () => {
    const registration = registrationFor(() => {
      throw new Error("boom");
    });

    const compiled = compileTool(registration, {
      agentId: "a1",
      effectPort: directToolEffectPort,
      policy: fakePolicy(() => ({ kind: "allow", source: "grant" })),
    });

    await expect(
      compiled.execute?.({ x: 1 }, callOptions("c1"))
    ).rejects.toThrow("boom");
  });

  it("forwards the abort signal to the underlying execute untouched", async () => {
    const execute = vi.fn(
      (_input: { x: number }, options: ToolExecutionOptions<unknown>) =>
        options.abortSignal
    );
    const registration = registrationFor(execute);
    const controller = new AbortController();

    const compiled = compileTool(registration, {
      agentId: "a1",
      effectPort: directToolEffectPort,
      policy: fakePolicy(() => ({ kind: "allow", source: "grant" })),
    });

    const result: unknown = await compiled.execute?.(
      { x: 1 },
      callOptions("c1", { abortSignal: controller.signal })
    );
    expect(result).toBe(controller.signal);
  });

  it("duplicate continuation: a second call with the same toolCallId executes again (no built-in dedupe)", async () => {
    const execute = vi.fn(() => "ran");
    const registration = registrationFor(execute);

    const compiled = compileTool(registration, {
      agentId: "a1",
      effectPort: directToolEffectPort,
      policy: fakePolicy(() => ({ kind: "allow", source: "grant" })),
    });

    await compiled.execute?.({ x: 1 }, callOptions("c1"));
    await compiled.execute?.({ x: 1 }, callOptions("c1"));

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("passes agentId, sessionId, and call context through to capability()", async () => {
    const capability = vi.fn(
      () => ({ kind: "tool.call", source: "declared", tool: "double" }) as const
    );
    const registration: HarnessToolRegistration = {
      capability,
      name: "double",
      source: "declared",
      tool: tool({
        description: "doubles",
        execute: () => "ran",
        inputSchema: z.object({ x: z.number() }),
      }),
    };

    const compiled = compileTool(registration, {
      agentId: "agent-1",
      effectPort: directToolEffectPort,
      policy: fakePolicy(() => ({ kind: "allow", source: "grant" })),
      sessionId: "sess-1",
    });

    await compiled.execute?.(
      { x: 1 },
      { context: { foo: 1 }, messages: [], toolCallId: "c9" }
    );

    expect(capability).toHaveBeenCalledWith(
      { x: 1 },
      {
        agentId: "agent-1",
        experimentalContext: { foo: 1 },
        messages: [],
        sessionId: "sess-1",
        toolCallId: "c9",
      }
    );
  });

  it("derives command authority from validated input and bound context, not the tool name", () => {
    const known = [
      {
        command: { id: "analysis.execute", version: 1 },
        domain: "analysis",
        effects: ["compute"],
      },
    ] as const satisfies readonly CommandAuthorityDefinition[];
    const inputSchema = z.object({ scope: z.string() });
    const contextSchema = z.object({ projectId: z.string() });
    const fallback = { source: "declared", tool: "analyze" } as const;
    const registration: HarnessToolRegistration = {
      capability(input, context) {
        const parsedInput = inputSchema.safeParse(input);
        const parsedContext = contextSchema.safeParse(
          context.experimentalContext
        );
        const authority =
          parsedInput.success &&
          parsedContext.success &&
          parsedInput.data.scope.startsWith(
            `code:${parsedContext.data.projectId}`
          )
            ? {
                command: { id: "analysis.execute", version: 1 },
                domain: "analysis",
                effect: "compute",
                kind: "domain.command",
                target: {
                  projectId: parsedContext.data.projectId,
                  scope: parsedInput.data.scope,
                },
              }
            : null;
        return classifyCommandCapability(authority, known, fallback);
      },
      name: "analyze",
      source: "declared",
      tool: tool({ execute: () => "ran", inputSchema }),
    };
    const compiled = compileRegistrations([registration], {
      agentId: "a1",
      effectPort: directToolEffectPort,
      policy: fakePolicy(() => ({ kind: "allow", source: "grant" })),
    });

    expect(
      compiled.registrationFor(
        "analyze",
        { scope: "code:p1/src" },
        {
          experimentalContext: { projectId: "p1" },
          messages: [],
          toolCallId: "c1",
        }
      )?.capability
    ).toEqual({
      command: { id: "analysis.execute", version: 1 },
      domain: "analysis",
      effect: "compute",
      kind: "domain.command",
      target: { projectId: "p1", scope: "code:p1/src" },
    });
    expect(
      compiled.registrationFor(
        "analyze",
        { scope: "code:p2" },
        {
          experimentalContext: { projectId: "p1" },
          messages: [],
          toolCallId: "c2",
        }
      )?.capability
    ).toEqual({ kind: "tool.call", ...fallback });
  });

  it("passes through a tool with no execute unchanged — nothing to gate", () => {
    const clientTool = tool({
      description: "client-executed",
      inputSchema: z.object({ x: z.number() }),
    });
    const registration: HarnessToolRegistration = {
      capability: () => ({
        kind: "tool.call",
        source: "declared",
        tool: "client",
      }),
      name: "client",
      source: "declared",
      tool: clientTool,
    };

    const compiled = compileTool(registration, {
      agentId: "a1",
      effectPort: directToolEffectPort,
      policy: fakePolicy(() => ({ kind: "allow", source: "grant" })),
    });

    expect(compiled).toBe(clientTool);
  });
});

describe("tool-compiler — tagged tools", () => {
  it("a tool's own ToolMeta reaches the compiled call's capability and source", () => {
    const fetchTool = tool({
      description: "fetch",
      execute: () => "ok",
      inputSchema: z.object({ url: z.string() }),
    });
    const compiled = compileTools(
      {
        plain: tool({
          description: "plain",
          execute: () => "ok",
          inputSchema: z.object({}),
        }),
        web_fetch: tagTool(fetchTool, {
          capability: () => ({ domain: "example.com", kind: "web.fetch" }),
          source: "builtin",
        }),
      },
      {
        agentId: "a1",
        effectPort: directToolEffectPort,
        policy: fakePolicy(() => ({ kind: "allow", source: "grant" })),
      }
    );

    const call = { messages: [], toolCallId: "c1" };
    expect(compiled.registrationFor("plain", {}, call)).toMatchObject({
      capability: { kind: "tool.call", source: "declared", tool: "plain" },
      source: "declared",
    });
    expect(
      compiled.registrationFor("web_fetch", { url: "https://x" }, call)
    ).toMatchObject({
      capability: { domain: "example.com", kind: "web.fetch" },
      source: "builtin",
    });
  });
});

describe("tool-compiler — plain tool map", () => {
  it("wraps a raw tool map and still fails closed absent an explicit grant or kind default", async () => {
    const execute = vi.fn(() => "ran");
    const raw = {
      legacy: tool({
        description: "legacy tool",
        execute,
        inputSchema: z.object({}),
      }),
    };

    const registrations = registrationsOf(raw, "declared");
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.capability({}, {} as never)).toEqual({
      kind: "tool.call",
      source: "declared",
      tool: "legacy",
    });

    // The real policy from Task 01 — a blanket "allow" global default still
    // cannot reach the unclassified `tool.call` capability.
    const policy = createInMemoryAgentAuthorizer({
      policy: { global: "allow" },
    }).authorizer;

    const compiled = compileRegistrations(registrations, {
      agentId: "a1",
      effectPort: directToolEffectPort,
      policy,
    });

    const result: unknown = await compiled.tools.legacy?.execute?.(
      {},
      callOptions("c1")
    );
    expect(result).toMatchObject({ approved: false });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("tool-compiler — withToolCallRegistration", () => {
  /** A ready-made one-item `AsyncIterable`, without a generator (an `async
   *  function*` with no internal `await` trips the lint rule that exists to
   *  catch a genuinely missing await, which doesn't apply to a generator's
   *  synchronous `yield`). */
  function singleChunk<T>(chunk: T): AsyncIterable<T> {
    let done = false;
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<T>> =>
          done
            ? Promise.resolve({ done: true, value: undefined })
            : ((done = true), Promise.resolve({ done: false, value: chunk })),
      }),
    };
  }

  it("stamps registration provenance on an ordinary tool call", async () => {
    const registration: HarnessToolRegistration = {
      ...registrationFor(() => "ran"),
      capability: () => ({
        kind: "mcp.tool",
        serverId: "github",
        tool: "double",
      }),
      source: "mcp",
    };
    const compiled = compileRegistrations([registration], {
      agentId: "a1",
      effectPort: directToolEffectPort,
      policy: fakePolicy(() => ({ kind: "allow", source: "grant" })),
    });
    const source = singleChunk({
      input: { x: 1 },
      toolCallId: "c1",
      toolName: "double",
      type: "tool-call",
    });

    const out: unknown[] = [];
    for await (const chunk of withToolCallRegistration(
      source,
      compiled.registrationFor,
      { agentId: "a1", messages: [] }
    )) {
      out.push(chunk);
    }

    expect(out).toEqual([
      {
        input: { x: 1 },
        provenance: {
          agentId: "a1",
          capability: {
            kind: "mcp.tool",
            serverId: "github",
            tool: "double",
          },
          effectLocation: "runtime",
          invocationId: "a1:c1",
          source: "mcp",
        },
        toolCallId: "c1",
        toolName: "double",
        type: "tool-call",
      },
    ]);
  });

  it("registers runtime and host effects as the same call envelope", () => {
    const runtime = registrationFor(() => "ran");
    const host: HarnessToolRegistration = {
      capability: () => ({
        kind: "tool.call",
        source: "declared",
        tool: "render",
      }),
      name: "render",
      source: "declared",
      tool: tool({
        description: "render in the embedding host",
        inputSchema: z.object({ target: z.string() }),
      }),
    };
    const compiled = compileRegistrations([runtime, host], {
      agentGeneration: 2,
      agentId: "a1",
      effectPort: directToolEffectPort,
      policy: fakePolicy(() => ({ kind: "allow", source: "grant" })),
      sessionId: "s1",
    });

    expect(
      compiled.registrationFor(
        "double",
        { x: 2 },
        {
          messages: [],
          toolCallId: "runtime-1",
        }
      )
    ).toEqual({
      agentGeneration: 2,
      agentId: "a1",
      capability: {
        kind: "tool.call",
        source: "declared",
        tool: "double",
      },
      effectLocation: "runtime",
      input: { x: 2 },
      invocationId: "a1:s1:runtime-1",
      sessionId: "s1",
      source: "declared",
      toolCallId: "runtime-1",
      toolName: "double",
    });
    expect(
      compiled.registrationFor(
        "render",
        { target: "canvas" },
        {
          messages: [],
          toolCallId: "host-1",
        }
      )
    ).toEqual({
      agentGeneration: 2,
      agentId: "a1",
      capability: {
        kind: "tool.call",
        source: "declared",
        tool: "render",
      },
      effectLocation: "host",
      input: { target: "canvas" },
      invocationId: "a1:s1:host-1",
      sessionId: "s1",
      source: "declared",
      toolCallId: "host-1",
      toolName: "render",
    });
  });
});
