import { createInMemoryAgentAuthorizer } from "@foundry/agents/authorization";
import type {
  AgentModel,
  HarnessQuestionRequest,
  HarnessQuestionResult,
  HarnessSession,
} from "@foundry/agents/harness";
import {
  InMemorySessionStore,
  type SessionMessage,
} from "@foundry/agents/session";
import type { Container } from "@foundry/sandbox/container/containers";
import type { ToolSet } from "ai";
import { tool as createTool } from "ai";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { delegationTool } from "~/lib/sandbox/delegate";
import {
  createSandboxSession,
  type SandboxSessionSettings,
} from "~/lib/sandbox/session";

/** What the built-in harness was opened with: its session id and its tools. */
const builtinSettings: {
  readonly sessionId?: string;
  readonly tools?: ToolSet;
}[] = [];
vi.mock("@foundry/agents/harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@foundry/agents/harness")>()),
  createBuiltinCodingHarness: (input: {
    readonly sessionId?: string;
    readonly tools?: ToolSet;
  }) => {
    builtinSettings.push(input);
    return child();
  },
}));

function settings(): SandboxSessionSettings {
  return {
    agentId: "worker",
    container: {} as Container,
    harness: "codex",
    instructions: "Parent instructions",
    modelId: "model",
    options: {
      authority: { policy: createInMemoryAgentAuthorizer().authorizer },
      profile: {
        allowedTools: ["Read", "delegate"],
        disallowedTools: ["Bash"],
        maxSteps: 7,
        mode: "scheduled",
        unresolved: "deny",
      },
      sandbox: {
        close: async () => undefined,
        exec: async () => ({ exitCode: 0, stderr: "", stdout: "" }),
        id: "sandbox",
      },
    },
    provider: "provider",
    sessionId: "parent",
    signal: new AbortController().signal,
    store: new InMemorySessionStore(),
    write: () => undefined,
  };
}

function reply(status: SessionMessage["status"] = "complete"): SessionMessage {
  return {
    createdAt: 1,
    id: "message",
    parts: [{ text: "Task result", type: "text" }],
    role: "assistant",
    sessionId: "child",
    status,
    updatedAt: 1,
  };
}

function child(
  generate: HarnessSession["generate"] = async () => reply()
): HarnessSession {
  return {
    capabilities: { interruption: true, steering: false },
    close: vi.fn(async () => undefined),
    generate,
    interrupt: vi.fn(async () => undefined),
    route: { id: "model", provider: "provider" },
    sessionId: "child",
    steer: async () => undefined,
    store: new InMemorySessionStore(),
    stream: () => {
      throw new Error("unused");
    },
  };
}

function invoke(
  tool: ReturnType<typeof delegationTool>,
  abortSignal?: AbortSignal
) {
  if (!tool.execute) {
    throw new Error("Missing execution");
  }
  return tool.execute(
    { task: "Inspect the module", title: "Review" },
    { abortSignal, context: {}, messages: [], toolCallId: "call" }
  );
}

it("inherits sandbox, model and exact authority without widening the child profile", async () => {
  const parent = settings();
  const activity = vi.fn();
  parent.onActivity = activity;
  const session = child();
  const open = vi.fn(async (_settings: SandboxSessionSettings) => session);
  const result = await invoke(delegationTool(parent, open));
  const passed = open.mock.calls[0]?.[0];
  expect(passed).toBeDefined();
  expect(passed?.options.sandbox).toBe(parent.options.sandbox);
  expect(passed?.options.authority).toBe(parent.options.authority);
  expect(passed?.options.profile).toBe(parent.options.profile);
  expect(passed?.instructions).toBe(parent.instructions);
  expect(passed?.provider).toBe(parent.provider);
  expect(passed?.modelId).toBe(parent.modelId);
  expect(passed?.sessionId).not.toBe(parent.sessionId);
  expect(result).toMatchObject({ text: "Task result" });
  expect(session.close).toHaveBeenCalledOnce();
  expect(activity.mock.calls.map(([event]) => event.status)).toEqual([
    "running",
    "complete",
  ]);
  expect(
    await parent.store.getSession(passed?.sessionId ?? "missing")
  ).toMatchObject({ parentSessionId: parent.sessionId, recursionDepth: 1 });
});

it("enforces nesting and total launch bounds before opening a child", async () => {
  const parent = settings();
  const open = vi.fn(async () => child());
  parent.delegation = { budget: { active: 0, started: 0 }, depth: 3 };
  await expect(invoke(delegationTool(parent, open))).rejects.toThrow("limit");
  parent.delegation = { budget: { active: 0, started: 8 }, depth: 0 };
  await expect(invoke(delegationTool(parent, open))).rejects.toThrow("limit");
  expect(open).not.toHaveBeenCalled();
});

it("limits concurrent children and shares the launch budget across descendants", async () => {
  const parent = settings();
  const budget = { active: 0, started: 0 };
  parent.delegation = { budget, depth: 0 };
  let complete: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const opened: SandboxSessionSettings[] = [];
  const tool = delegationTool(parent, async (passed) => {
    opened.push(passed);
    return child(async () => {
      await held;
      return reply();
    });
  });
  const first = invoke(tool);
  const second = invoke(tool);
  await expect(invoke(tool)).rejects.toThrow("limit");
  expect(budget).toEqual({ active: 2, started: 2 });
  complete();
  await Promise.all([first, second]);
  expect(budget.active).toBe(0);
  expect(opened[0]?.delegation?.budget).toBe(budget);
  expect(opened[0]?.delegation?.depth).toBe(1);
});

it("closes cancelled children and records cancellation after parent abort", async () => {
  const parent = settings();
  const controller = new AbortController();
  parent.signal = controller.signal;
  const activity = vi.fn();
  parent.onActivity = activity;
  let entered: () => void = () => undefined;
  const generating = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const session = child(
    async (_input, options) =>
      await new Promise<SessionMessage>((_resolve, reject) => {
        entered();
        options?.signal?.addEventListener(
          "abort",
          () => reject(new Error("cancelled")),
          { once: true }
        );
      })
  );
  const running = invoke(delegationTool(parent, async () => session));
  const outcome = Promise.resolve(running).then(
    () => "complete",
    () => "cancelled"
  );
  await generating;
  controller.abort();
  expect(await outcome).toBe("cancelled");
  expect(session.close).toHaveBeenCalledOnce();
  expect(activity.mock.calls.map(([event]) => event.status)).toEqual([
    "running",
    "cancelled",
  ]);
});

it("records a failed child turn and releases its concurrency slot", async () => {
  const parent = settings();
  const budget = { active: 0, started: 0 };
  parent.delegation = { budget, depth: 0 };
  const activity = vi.fn();
  parent.onActivity = activity;
  const session = child(async () => reply("error"));
  await expect(
    invoke(delegationTool(parent, async () => session))
  ).rejects.toThrow("failed");
  expect(activity.mock.calls.map(([event]) => event.status)).toEqual([
    "running",
    "failed",
  ]);
  expect(session.close).toHaveBeenCalledOnce();
  expect(budget).toEqual({ active: 0, started: 1 });
});

it("stopping a managed child aborts its task and delegates to the harness interrupt", async () => {
  const parent = settings();
  let attached: HarnessSession | undefined;
  parent.onChildSession = (_id, attachedSession) => {
    attached = attachedSession;
    return attachedSession;
  };
  let entered: () => void = () => undefined;
  const generating = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const session = child(
    async (_input, options) =>
      await new Promise<SessionMessage>((_resolve, reject) => {
        entered();
        options?.signal?.addEventListener(
          "abort",
          () => reject(new Error("stopped")),
          { once: true }
        );
      })
  );
  const { interrupt } = session;
  const outcome = Promise.resolve(
    invoke(delegationTool(parent, async () => session))
  ).then(
    () => "complete",
    () => "cancelled"
  );
  await generating;
  expect(attached).not.toBe(session);
  expect(session.interrupt).toBe(interrupt);
  await attached?.interrupt();
  expect(await outcome).toBe("cancelled");
  expect(interrupt).toHaveBeenCalledOnce();
  expect(session.close).toHaveBeenCalledOnce();
});

it("drives and closes the session the host tracks the child as", async () => {
  const parent = settings();
  const session = child();
  const tracked = child();
  parent.onChildSession = () => tracked;
  const result = await invoke(delegationTool(parent, async () => session));
  expect(result).toMatchObject({ text: "Task result" });
  expect(tracked.close).toHaveBeenCalledOnce();
  expect(session.close).not.toHaveBeenCalled();
});

it("links child questions and nested activity updates to the managed activity", async () => {
  const parent = settings();
  const question = vi.fn(
    async (
      _request: HarnessQuestionRequest
    ): Promise<HarnessQuestionResult> => ({ answers: {}, outcome: "answered" })
  );
  const activity = vi.fn();
  parent.options = { ...parent.options, question };
  parent.onActivity = activity;
  let passed: SandboxSessionSettings | undefined;
  await invoke(
    delegationTool(parent, async (childSettings) => {
      passed = childSettings;
      return child();
    })
  );
  if (!passed) {
    throw new Error("No child settings");
  }
  await passed.options.question?.({
    questions: [],
    sessionId: passed.sessionId,
    signal: parent.signal,
    toolCallId: "question",
  });
  expect(question.mock.calls[0]?.[0]).toMatchObject({
    activityId: passed.sessionId,
  });
  expect(passed.parentActivityId).toBe(passed.sessionId);
});

it("rebuilds host tools for the child's own session through the actual session factory", async () => {
  builtinSettings.length = 0;
  const parent = settings();
  parent.harness = "builtin";
  // The built-in path needs a network model; the harness itself is stubbed.
  parent.model = {} as AgentModel;
  parent.hostToolsForSession = (sessionId) => ({
    owned: createTool({
      execute: async () => sessionId,
      inputSchema: z.object({}),
    }),
  });
  await createSandboxSession(parent);
  const [rootSettings] = builtinSettings;
  const delegate = rootSettings?.tools?.delegate;
  if (!delegate?.execute) {
    throw new Error("Missing delegate tool");
  }
  await delegate.execute(
    { task: "Review", title: "Child" },
    { context: {}, messages: [], toolCallId: "delegate-call" }
  );
  const [, childSettings] = builtinSettings;
  const owned = childSettings?.tools?.owned;
  if (!owned?.execute) {
    throw new Error("Missing child tool");
  }
  expect(childSettings?.sessionId).not.toBe(parent.sessionId);
  expect(
    await owned.execute(
      {},
      { context: {}, messages: [], toolCallId: "owner-call" }
    )
  ).toBe(childSettings?.sessionId);
});

it("records cleanup failures as failed rather than completed tasks", async () => {
  const parent = settings();
  const activity = vi.fn();
  parent.onActivity = activity;
  const session = child();
  session.close = async () => {
    throw new Error("cleanup failed");
  };
  await expect(
    invoke(delegationTool(parent, async () => session))
  ).rejects.toThrow("cleanup failed");
  expect(activity.mock.calls.map(([event]) => event.status)).toEqual([
    "running",
    "failed",
  ]);
});
