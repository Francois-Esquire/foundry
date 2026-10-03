import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { HarnessQuestionCallback } from "@foundry/agents/harness";
import { createHarnessQuestionTool } from "@foundry/agents/harness";
import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import { describe, expect, it, vi } from "vitest";
import { createClaudeCodeDriver } from "../harness/claude-code";
import { createCodexDriver } from "../harness/codex";
import { collect, FakeAppServer, runOptions } from "./helpers/cli";

const claudeInput = {
  answers: { "Which database?": "fabricated model answer" },
  questions: [
    {
      header: "Database",
      multiSelect: false,
      options: [
        { description: "Embedded", label: "SQLite" },
        { description: "Server", label: "Postgres" },
      ],
      question: "Which database?",
    },
    {
      header: "Features",
      multiSelect: true,
      options: [
        { description: "Store results", label: "Cache" },
        { description: "Record changes", label: "Audit" },
      ],
      question: "Which features?",
    },
  ],
};

function claudeFixture(
  exercise: (settings: ClaudeCodeSettings, signal: AbortSignal) => Promise<void>
) {
  let settings: ClaudeCodeSettings = {};
  const model: LanguageModelV4 = {
    doGenerate: vi.fn(),
    async doStream(options) {
      await exercise(
        settings,
        options.abortSignal ?? new AbortController().signal
      );
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
      };
    },
    modelId: "sonnet",
    provider: "claude-code",
    specificationVersion: "v4",
    supportedUrls: {},
  };
  return createClaudeCodeDriver({
    agentId: "agent-1",
    createModel: (_modelId, value) => {
      settings = value;
      return model;
    },
    cwd: "/workspace",
    modelId: "sonnet",
    spawnClaudeCodeProcess: vi.fn(),
  });
}

function preQuestion(settings: ClaudeCodeSettings) {
  return settings.hooks?.PreToolUse?.[0]?.hooks[0]?.({
    tool_input: claudeInput,
    tool_name: "AskUserQuestion",
    tool_use_id: "ask-1",
  });
}

function codexFixture() {
  const child = new FakeAppServer();
  const driver = createCodexDriver({
    agentId: "agent-1",
    binPath: "/opt/foundry/bin/codex",
    cwd: "/workspace",
    modelId: "gpt-5.4",
    spawn: async () => child,
  });
  const request = () =>
    child.send({
      id: "question-request",
      method: "item/tool/requestUserInput",
      params: {
        itemId: "ask-1",
        questions: [
          {
            header: "Database",
            id: "database",
            isOther: true,
            isSecret: false,
            options: [{ description: "Embedded", label: "SQLite" }],
            question: "Which database?",
          },
        ],
        threadId: "thread-1",
        turnId: "turn-1",
      },
    });
  const response = () =>
    child.messages.find((message) => message.id === "question-request");
  const finish = () =>
    child.send({
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "completed" } },
    });
  return { child, driver, finish, request, response };
}

describe("native user questions", () => {
  it("returns actual Claude single and multi-select answers once across both permission paths", async () => {
    const permission = vi.fn();
    const question = vi.fn<HarnessQuestionCallback>(async (request) => {
      expect(request.questions.map((value) => value.id)).toEqual([
        "ask-1:0",
        "ask-1:1",
      ]);
      expect(request.questions[0]?.options?.[0]?.label).toBe("SQLite");
      return {
        answers: {
          "ask-1:0": ["My custom database"],
          "ask-1:1": ["Cache", "Audit"],
        },
        outcome: "answered",
      };
    });
    const driver = claudeFixture(async (settings, signal) => {
      const hook = await preQuestion(settings);
      expect(hook).toMatchObject({
        hookSpecificOutput: {
          permissionDecision: "allow",
          updatedInput: {
            answers: {
              "Which database?": "My custom database",
              "Which features?": "Cache, Audit",
            },
            questions: claudeInput.questions,
          },
        },
      });
      expect(
        await settings.canUseTool?.("AskUserQuestion", claudeInput, {
          requestId: "permission-1",
          signal,
          toolUseID: "ask-1",
        })
      ).toMatchObject({
        behavior: "allow",
        updatedInput: {
          answers: {
            "Which database?": "My custom database",
            "Which features?": "Cache, Audit",
          },
        },
      });
    });
    await collect(await driver.run(runOptions({ permission, question })));
    expect(question).toHaveBeenCalledTimes(1);
    expect(permission).not.toHaveBeenCalled();
  });

  it("denies Claude questions explicitly when the host declines", async () => {
    const question = vi.fn<HarnessQuestionCallback>(async () => ({
      outcome: "declined",
      reason: "User declined",
    }));
    const events: string[] = [];
    const driver = claudeFixture(async (settings, signal) => {
      expect(await preQuestion(settings)).toMatchObject({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: "User declined",
        },
      });
      expect(
        await settings.canUseTool?.("AskUserQuestion", claudeInput, {
          requestId: "permission-1",
          signal,
          toolUseID: "ask-1",
        })
      ).toEqual({ behavior: "deny", message: "User declined" });
    });
    await collect(
      await driver.run(
        runOptions({
          onToolEvent: async (event) => {
            events.push(event.outcome);
          },
          question,
        })
      )
    );
    expect(question).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["started", "refused"]);
  });

  it("aborts pending Claude questions even when the host ignores cancellation", async () => {
    const abort = new AbortController();
    const started = vi.fn();
    const question: HarnessQuestionCallback = () => {
      started();
      return new Promise(() => undefined);
    };
    const driver = claudeFixture(async (settings) => {
      await preQuestion(settings);
    });
    const turn = driver.run(runOptions({ question, signal: abort.signal }));
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    abort.abort();
    await expect(turn).rejects.toMatchObject({ name: "AbortError" });
  });

  it("returns Codex answers keyed by native question id without effect approval", async () => {
    const fixture = codexFixture();
    const permission = vi.fn();
    const question = vi.fn<HarnessQuestionCallback>(async (request) => {
      expect(request).toMatchObject({
        questions: [{ id: "database", question: "Which database?" }],
        sessionId: "session-1",
        toolCallId: "ask-1",
      });
      return {
        answers: { database: ["Custom database"] },
        outcome: "answered",
      };
    });
    const source = await fixture.driver.run(
      runOptions({
        permission,
        profile: {
          allowedTools: ["Read"],
          disallowedTools: [],
          maxSteps: 4,
          mode: "attended",
          unresolved: "ask",
        },
        question,
      })
    );
    fixture.request();
    await vi.waitFor(() =>
      expect(fixture.response()).toEqual({
        id: "question-request",
        result: { answers: { database: { answers: ["Custom database"] } } },
      })
    );
    fixture.finish();
    await collect(source);
    expect(permission).not.toHaveBeenCalled();
    expect(question).toHaveBeenCalledTimes(1);
  });

  it.each(["declined", "incomplete"])(
    "rejects Codex %s replies without fabricating an empty success",
    async (kind) => {
      const fixture = codexFixture();
      const question: HarnessQuestionCallback = async () =>
        kind === "declined"
          ? { outcome: "declined", reason: "User declined" }
          : { answers: {}, outcome: "answered" };
      const events: string[] = [];
      const source = await fixture.driver.run(
        runOptions({
          onToolEvent: async (event) => {
            events.push(event.outcome);
          },
          profile: {
            allowedTools: [],
            disallowedTools: [],
            maxSteps: 4,
            mode: "attended",
            unresolved: "ask",
          },
          question,
        })
      );
      fixture.request();
      await vi.waitFor(() =>
        expect(fixture.response()).toMatchObject({
          error: { code: -32_000 },
          id: "question-request",
        })
      );
      expect(fixture.response()).not.toHaveProperty("result");
      fixture.finish();
      await collect(source);
      expect(events).toEqual(["started", "refused"]);
    }
  );

  it.each(["abort", "interrupt", "close"])(
    "kills the Codex guest and sends no answer when a pending question is canceled via %s",
    async (kind) => {
      const fixture = codexFixture();
      const abort = new AbortController();
      const started = vi.fn();
      const source = await fixture.driver.run(
        runOptions({
          profile: {
            allowedTools: [],
            disallowedTools: [],
            maxSteps: 4,
            mode: "attended",
            unresolved: "ask",
          },
          question: () => {
            started();
            return new Promise(() => undefined);
          },
          signal: abort.signal,
        })
      );
      fixture.request();
      await vi.waitFor(() => expect(started).toHaveBeenCalled());
      if (kind === "abort") {
        abort.abort();
      } else if (kind === "interrupt") {
        await fixture.driver.interrupt?.();
      } else {
        await fixture.driver.close?.();
      }
      expect(fixture.child.killed).toBe(true);
      expect(fixture.response()).toBeUndefined();
      expect(await collect(source)).toEqual([
        expect.objectContaining({ type: "error" }),
      ]);
    }
  );

  it("allows trusted Claude communication tools by identity, while ordinary tools still need permission", async () => {
    const trusted = createHarnessQuestionTool({ sessionId: "session-1" });
    const permission = vi.fn(async () => ({
      behavior: "deny" as const,
      message: "Denied",
    }));
    const driver = claudeFixture(async (settings) => {
      for (const [name, decision] of [
        ["question_alias", "allow"],
        ["ask_user", "deny"],
      ]) {
        expect(
          await settings.hooks?.PreToolUse?.[0]?.hooks[0]?.({
            tool_input: { questions: [] },
            tool_name: `mcp__foundry__${name}`,
            tool_use_id: name,
          })
        ).toMatchObject({
          hookSpecificOutput: { permissionDecision: decision },
        });
      }
    });
    await collect(
      await driver.run(
        runOptions({
          permission,
          tools: {
            ask_user: { ...trusted, execute: async () => "ordinary" },
            question_alias: { ...trusted },
          },
        })
      )
    );
    expect(permission).toHaveBeenCalledTimes(1);
  });

  it("executes the trusted Codex question tool on the host and refuses an ordinary tool with the same name", async () => {
    const fixture = codexFixture();
    const question = vi.fn<HarnessQuestionCallback>(async () => ({
      answers: { database: ["SQLite"] },
      outcome: "answered",
    }));
    const trusted = createHarnessQuestionTool({
      question,
      sessionId: "session-1",
    });
    const permission = vi.fn(async () => ({
      behavior: "deny" as const,
      message: "Denied",
    }));
    const source = await fixture.driver.run(
      runOptions({
        permission,
        profile: {
          allowedTools: [],
          disallowedTools: [],
          maxSteps: 4,
          mode: "attended",
          unresolved: "ask",
        },
        question,
        tools: {
          ask_user: { ...trusted, execute: async () => "ordinary" },
          question_alias: { ...trusted },
        },
      })
    );
    for (const name of ["question_alias", "ask_user"]) {
      fixture.child.send({
        id: name,
        method: "item/tool/call",
        params: {
          arguments: {
            questions: [{ id: "database", question: "Which database?" }],
          },
          callId: name,
          tool: name,
        },
      });
    }
    await vi.waitFor(() =>
      expect(
        fixture.child.messages.find((message) => message.id === "ask_user")
      ).toMatchObject({ result: { success: false } })
    );
    const reply = fixture.child.messages.find(
      (message) => message.id === "question_alias"
    );
    expect(reply).toMatchObject({
      result: {
        contentItems: [
          {
            text: JSON.stringify({
              answers: { database: ["SQLite"] },
              outcome: "answered",
            }),
          },
        ],
        success: true,
      },
    });
    fixture.finish();
    await collect(source);
    expect(question).toHaveBeenCalledTimes(1);
    expect(permission).toHaveBeenCalledTimes(1);
  });
});
