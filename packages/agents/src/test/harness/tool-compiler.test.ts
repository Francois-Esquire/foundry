import type { AccessRequest } from "@foundry/authorization";
import type { TextStreamPart, Tool, ToolExecutionOptions, ToolSet } from "ai";

import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMemoryAuthorization } from "../../authorization/authorization";
import type { CommandAuthorityDefinition } from "../../authorization/capability";
import { classifyCommandCapability } from "../../authorization/capability";
import {
  compileRegistrations,
  compileTool,
  compileTools,
  isPolicyDeniedOutput,
  toolAccessRequest,
  withToolCallRegistration,
} from "../../harness/tool-compiler";
import type { HarnessToolRegistration } from "../../harness/tool-registration";
import { registrationsOf, tagTool } from "../../harness/tool-registration";
import {
  createPermissiveAuthorization,
  denyAction,
  grantCapability,
} from "../helpers/authorizer";

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

function needsApproval(
  compiled: Tool,
  input: unknown,
  options: { toolCallId: string; messages: unknown[]; context?: unknown }
): Promise<boolean> {
  const fn = compiled.needsApproval as (
    input: unknown,
    options: unknown
  ) => Promise<boolean>;
  return fn(input, options);
}

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
  it("allow: executes exactly once", async () => {
    const execute = vi.fn(({ x }: { x: number }) => x * 2);
    const registration = registrationFor(execute);
    const compiled = compileTool(registration, {
      agentId: "a1",
      authorization: await createPermissiveAuthorization(),
      sessionId: "s1",
    });

    const result: unknown = await compiled.execute?.(
      { x: 2 },
      callOptions("call-1")
    );

    expect(result).toBe(4);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("streaming tool: the compiled execute is itself a generator that yields interim results from one execution", async () => {
    const execute = vi.fn(async function* ({ x }: { x: number }) {
      yield x;
      await Promise.resolve();
      yield x * 2;
    });
    const registration = registrationFor(execute);
    const compiled = compileTool(registration, {
      agentId: "a1",
      authorization: await createPermissiveAuthorization(),
      sessionId: "s1",
    });

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
  });

  it("streaming tool: a denial is yielded once and the original never runs", async () => {
    const execute = vi.fn(async function* () {
      await Promise.resolve();
      yield "should not run";
    });
    const authorization = createMemoryAuthorization();
    await denyAction(authorization, "tool.call", "nope");
    const compiled = compileTool(registrationFor(execute), {
      agentId: "a1",
      authorization,
      sessionId: "s1",
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
    const authorization = createMemoryAuthorization();
    await denyAction(authorization, "tool.call", "nope");

    const compiled = compileTool(registration, {
      agentId: "a1",
      authorization,
      sessionId: "s1",
    });

    const result: unknown = await compiled.execute?.(
      { x: 2 },
      callOptions("c1")
    );

    expect(result).toEqual({ approved: false, reason: "nope" });
    expect(isPolicyDeniedOutput(result)).toBe(true);
    expect(isPolicyDeniedOutput({ approved: false, reason: "nope" })).toBe(
      false
    );
    expect(isPolicyDeniedOutput(structuredClone(result))).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("approval-required: needsApproval reports true, and a defensive execute still denies", async () => {
    const execute = vi.fn(() => "should not run");
    const registration = registrationFor(execute);

    const compiled = compileTool(registration, {
      agentId: "a1",
      authorization: createMemoryAuthorization(),
      sessionId: "s1",
    });

    const needs = await needsApproval(compiled, { x: 1 }, callOptions("c1"));
    expect(needs).toBe(true);

    const result: unknown = await compiled.execute?.(
      { x: 1 },
      callOptions("c1")
    );
    expect(result).toMatchObject({ approved: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it("approved replay executes once while live authorization still has no standing grant", async () => {
    const execute = vi.fn(() => "ran");
    const registration = registrationFor(execute);
    const compiled = compileTool(registration, {
      agentId: "a1",
      authorization: createMemoryAuthorization(),
      sessionId: "s1",
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

  it("sticky: needsApproval stays true once a request exists in history, even if authorization now allows", async () => {
    const registration = registrationFor(() => "ran");
    const compiled = compileTool(registration, {
      agentId: "a1",
      authorization: await createPermissiveAuthorization(),
      sessionId: "s1",
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

  it("preserves an existing needsApproval predicate alongside the authorization decision", async () => {
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
      authorization: await createPermissiveAuthorization(),
      sessionId: "s1",
    });

    const needs = await needsApproval(compiled, { x: 1 }, callOptions("c1"));
    expect(needs).toBe(true);
  });

  it("revoked continuation: execute re-authorizes against current authorization and denies", async () => {
    const execute = vi.fn(() => "should not run");
    const registration = registrationFor(execute);
    const authorization = createMemoryAuthorization();
    const grant = await grantCapability(authorization, "a1", {
      kind: "tool.call",
      source: "declared",
      tool: "double",
    });
    const compiled = compileTool(registration, {
      agentId: "a1",
      authorization,
      sessionId: "s1",
    });

    await authorization.revoke({ grantId: grant.id, kind: "grant" }, "revoked");
    const result: unknown = await compiled.execute?.(
      { x: 1 },
      callOptions("c1")
    );

    expect(result).toMatchObject({ approved: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it("a thrown effect propagates as a rejection, not a silent denial", async () => {
    const registration = registrationFor(() => {
      throw new Error("boom");
    });

    const compiled = compileTool(registration, {
      agentId: "a1",
      authorization: await createPermissiveAuthorization(),
      sessionId: "s1",
    });

    await expect(
      compiled.execute?.({ x: 1 }, callOptions("c1"))
    ).rejects.toThrow("boom");
  });

  it("wires permit.signal to the tool abortSignal so caller abort and live revocation both abort execution", async () => {
    const authorization = createMemoryAuthorization();
    const grant = await grantCapability(authorization, "a1", {
      kind: "tool.call",
      source: "declared",
      tool: "double",
    });
    let observedSignal: AbortSignal | undefined;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registration = registrationFor(async (_input, options) => {
      observedSignal = options.abortSignal;
      await waiting;
      return observedSignal?.aborted ? "aborted" : "ok";
    });
    const compiled = compileTool(registration, {
      agentId: "a1",
      authorization,
      sessionId: "s1",
    });

    const running = compiled.execute?.({ x: 1 }, callOptions("c1"));
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    expect(observedSignal?.aborted).toBe(false);
    await authorization.revoke({ grantId: grant.id, kind: "grant" }, "revoked");
    expect(observedSignal?.aborted).toBe(true);
    release();
    expect(await running).toBe("aborted");
  });

  it("prevents double-claiming the same invocationId on duplicate execution", async () => {
    const execute = vi.fn(() => "ran");
    const registration = registrationFor(execute);

    const compiled = compileTool(registration, {
      agentId: "a1",
      authorization: await createPermissiveAuthorization(),
      sessionId: "s1",
    });

    expect(await compiled.execute?.({ x: 1 }, callOptions("c1"))).toBe("ran");
    expect(await compiled.execute?.({ x: 1 }, callOptions("c1"))).toMatchObject(
      { approved: false }
    );
    expect(execute).toHaveBeenCalledTimes(1);
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
      authorization: await createPermissiveAuthorization(),
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

  it("derives command authority from validated input and bound context, not the tool name", async () => {
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
      authorization: await createPermissiveAuthorization(),
      sessionId: "s1",
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

  it("passes through a tool with no execute unchanged — nothing to gate", async () => {
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
      authorization: await createPermissiveAuthorization(),
      sessionId: "s1",
    });

    expect(compiled).toBe(clientTool);
  });
});

describe("tool-compiler — toolAccessRequest", () => {
  it("asks exactly what a compiled call asks, invocation id included", async () => {
    const authorization = await createPermissiveAuthorization();
    const requests: AccessRequest[] = [];
    const originalCheck = authorization.check.bind(authorization);
    vi.spyOn(authorization, "check").mockImplementation((request) => {
      requests.push(request);
      return originalCheck(request);
    });
    const compiled = compileRegistrations([registrationFor(() => "ran")], {
      agentGeneration: 2,
      agentId: "a1",
      authorization,
      sessionId: "s1",
    });

    await compiled.tools.double?.execute?.({ x: 1 }, callOptions("c1"));
    const registration = compiled.registrationFor(
      "double",
      { x: 1 },
      { messages: [], toolCallId: "c1" }
    );

    expect(requests[0]).toEqual(
      toolAccessRequest({
        agentGeneration: 2,
        agentId: "a1",
        capability: { kind: "tool.call", source: "declared", tool: "double" },
        input: { x: 1 },
        sessionId: "s1",
        tool: { name: "double", source: "declared" },
        toolCallId: "c1",
      })
    );
    expect(requests[0]).toMatchObject({
      invocationId: registration?.invocationId,
      sessionId: "s1",
    });
  });
});

describe("tool-compiler — tagged tools", () => {
  it("a tool's own ToolMeta reaches the compiled call's capability and source", async () => {
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
        authorization: await createPermissiveAuthorization(),
        sessionId: "s1",
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
  it("wraps a raw tool map and still fails closed absent an explicit grant", async () => {
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

    const compiled = compileRegistrations(registrations, {
      agentId: "a1",
      authorization: createMemoryAuthorization(),
      sessionId: "s1",
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
  function singleChunk<T>(chunk: T): AsyncIterable<T> {
    let done = false;
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<T>> => {
          if (done) {
            return Promise.resolve({ done: true, value: undefined });
          }
          done = true;
          return Promise.resolve({ done: false, value: chunk });
        },
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
      authorization: await createPermissiveAuthorization(),
      sessionId: "s1",
    });
    const source = singleChunk<TextStreamPart<ToolSet>>({
      input: { x: 1 },
      toolCallId: "c1",
      toolName: "double",
      type: "tool-call",
    });

    const out: unknown[] = [];
    for await (const chunk of withToolCallRegistration(
      source,
      compiled.registrationFor,
      { messages: [] }
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
          invocationId: "a1:s1:c1",
          sessionId: "s1",
          source: "mcp",
        },
        toolCallId: "c1",
        toolName: "double",
        type: "tool-call",
      },
    ]);
  });

  it("registers runtime and host effects as the same call envelope", async () => {
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
      authorization: await createPermissiveAuthorization(),
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
