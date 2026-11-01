import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { moduleQueue } from "~/main/execution/contract";
import { AUTHORING_DISALLOWED_TOOLS } from "~/main/modules/authoring/agent";
import { moduleDirectory } from "~/main/modules/local-library";
import { SOURCE_LIMITS } from "~/main/modules/source-admission";
import type { AuthoringTurnView } from "~/shared/authoring";
import { WORKS_TASKS } from "~/shared/execution";
import { authoringFixture } from "../helpers/authoring";
import { type ScriptedStep, scriptedModels } from "../helpers/authoring-model";
import { startTestExecution } from "../helpers/execution";
import { inlineExecution } from "../helpers/inline-execution";

const APP = "packages/app/src/App.tsx";

/** The real engine and the real agent session, on a scripted model. */
async function engineFixture(script: ScriptedStep[]) {
  const { models, prompts } = scriptedModels(script);
  const execution = await startTestExecution({ models });
  const fixture = await authoringFixture({ execution });
  return { ...fixture, execution, prompts };
}

async function settledTurn(
  fixture: {
    service: {
      conversation(id: string): Promise<{ turns: AuthoringTurnView[] }>;
    };
  },
  moduleId: string,
  turnId: string,
  match: (turn: AuthoringTurnView) => boolean = (turn) =>
    !["queued", "running"].includes(turn.status)
) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const { turns } = await fixture.service.conversation(moduleId);
    const turn = turns.find((candidate) => candidate.id === turnId);
    if (turn && match(turn)) {
      return turn;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The turn did not get there");
}

it("turns a request into a reviewable proposal, recorded on a correlated engine run", async () => {
  const fixture = await engineFixture([
    {
      tools: [
        {
          input: {
            content: "export const App = () => 'Hi';\n",
            file_path: `/workspace/${APP}`,
          },
          name: "write",
        },
        {
          input: { content: "# Notes\n", file_path: "/workspace/NOTES.md" },
          name: "write",
        },
      ],
    },
    { text: "Changed the app and added notes." },
  ]);
  const { details, module, service } = fixture;
  const sent = await service.send(module.id, {
    binding: fixture.binding,
    prompt: "Say hi",
    source: details.source,
  });
  const turn = await settledTurn(fixture, module.id, sent.id);
  expect(turn).toMatchObject({
    proposal: { paths: ["NOTES.md", APP], status: "pending" },
    status: "complete",
  });
  expect(turn.items).toContainEqual({
    kind: "text",
    text: "Changed the app and added notes.",
  });
  expect(
    turn.items.filter((item) => item.kind === "tool").map((item) => item.status)
  ).toEqual(["complete", "complete"]);

  const files = await service.proposal(module.id, sent.id);
  expect(files.proposal).toEqual({
    "NOTES.md": "# Notes\n",
    [APP]: "export const App = () => 'Hi';\n",
  });
  expect(files.base).toEqual({ "NOTES.md": null, [APP]: details.source[APP] });

  const run = fixture.execution.runs
    .list()
    .find((candidate) => candidate.name === WORKS_TASKS.authoringTurn);
  expect(run).toMatchObject({
    correlation: { moduleId: module.id, turnId: sent.id },
    queue: moduleQueue(module.id, "authoring"),
    status: "complete",
  });
  expect(run?.correlation.agentSessionId).toBeTruthy();
  expect(run?.observations.some((entry) => entry.kind === "model-turn")).toBe(
    true
  );
  // Nothing of the request or the files is on the run record.
  expect(JSON.stringify(run)).not.toContain("Say hi");
  expect(JSON.stringify(run)).not.toContain("# Notes");
});

it("shows a disallowed tool attempt as denied and still finishes", async () => {
  const fixture = await engineFixture([
    {
      tools: [
        {
          input: { at: "2030-01-01T00:00:00Z", key: "k", workflow: "w" },
          name: "create_automation",
        },
      ],
    },
    { text: "I may not schedule work here." },
  ]);
  const { details, module, service } = fixture;
  const sent = await service.send(module.id, {
    binding: fixture.binding,
    prompt: "Schedule something",
    source: details.source,
  });
  const turn = await settledTurn(fixture, module.id, sent.id);
  expect(turn.status).toBe("complete");
  expect(turn.items).toContainEqual(
    expect.objectContaining({
      kind: "tool",
      name: "create_automation",
      reason: "Denied by harness profile.",
      status: "denied",
    })
  );
  expect(turn.proposal).toBeUndefined();
  expect(AUTHORING_DISALLOWED_TOOLS).toContain("delegate");
});

it("routes ask_user to the owning chat and continues with the answer", async () => {
  const fixture = await engineFixture([
    {
      tools: [
        {
          input: {
            questions: [
              {
                id: "color",
                options: [{ label: "Blue" }, { label: "Red" }],
                question: "Which color?",
              },
            ],
          },
          name: "ask_user",
        },
      ],
    },
    { text: "Using it." },
  ]);
  const { details, module, service } = fixture;
  const sent = await service.send(module.id, {
    binding: fixture.binding,
    prompt: "Pick a color",
    source: details.source,
  });
  const waiting = await settledTurn(fixture, module.id, sent.id, (current) =>
    current.items.some(
      (item) => item.kind === "question" && item.status === "open"
    )
  );
  const question = waiting.items.find((item) => item.kind === "question");
  expect(question).toMatchObject({
    questions: [{ question: "Which color?" }],
  });
  await expect(
    service.answer(module.id, sent.id, "unknown", {
      answers: {},
      kind: "answer",
    })
  ).rejects.toThrow("no longer waiting");
  await service.answer(module.id, sent.id, (question as { id: string }).id, {
    answers: { color: ["Teal"] },
    kind: "answer",
  });
  const turn = await settledTurn(fixture, module.id, sent.id);
  expect(turn.status).toBe("complete");
  expect(turn.items).toContainEqual(
    expect.objectContaining({ kind: "question", status: "answered" })
  );
  const prompt = JSON.stringify(fixture.prompts.at(-1));
  expect(prompt).toContain("Teal");
  // Answers are never written to authoring state.
  const records = await readFile(
    path.join(
      fixture.directory,
      moduleDirectory(module.id),
      "turns",
      `${sent.id}.json`
    ),
    "utf8"
  );
  expect(records).not.toContain("Teal");
});

it("cancels a running turn and records the run cancelled", async () => {
  const fixture = await engineFixture([{ hold: true }]);
  const { details, module, service } = fixture;
  const sent = await service.send(module.id, {
    binding: fixture.binding,
    prompt: "Take your time",
    source: details.source,
  });
  await settledTurn(
    fixture,
    module.id,
    sent.id,
    (current) => current.status === "running"
  );
  await service.cancel(module.id, sent.id);
  const turn = await settledTurn(fixture, module.id, sent.id);
  expect(turn.status).toBe("cancelled");
  expect(turn.proposal).toBeUndefined();
  const run = fixture.execution.runs
    .list()
    .find((candidate) => candidate.correlation.turnId === sent.id);
  expect(run?.status).toBe("cancelled");
});

it("cancels a turn still waiting for the Module's authoring slot", async () => {
  const fixture = await engineFixture([{ hold: true }]);
  const { details, module, service } = fixture;
  const request = { binding: fixture.binding, source: details.source };
  const first = await service.send(module.id, { ...request, prompt: "One" });
  const second = await service.send(module.id, { ...request, prompt: "Two" });
  await settledTurn(
    fixture,
    module.id,
    first.id,
    (current) => current.status === "running"
  );
  expect(
    (await service.conversation(module.id)).turns.find(
      (turn) => turn.id === second.id
    )?.status
  ).toBe("queued");
  await service.cancel(module.id, second.id);
  expect((await settledTurn(fixture, module.id, second.id)).status).toBe(
    "cancelled"
  );
  await service.cancel(module.id, first.id);
  await settledTurn(fixture, module.id, first.id);
  const runs = fixture.execution.runs.list();
  expect(
    runs.find((run) => run.correlation.turnId === second.id)
  ).toMatchObject({ status: "cancelled" });
  expect(
    runs.find((run) => run.correlation.turnId === second.id)?.timestamps
      .startedAt
  ).toBeUndefined();
});

it("persists the Agent Session in the engine's Marbles session store", async () => {
  const { models } = scriptedModels([{ text: "Hello." }]);
  const directory = await mkdtemp(path.join(tmpdir(), "works-engine-"));
  onTestFinished(() =>
    rm(directory, { force: true, maxRetries: 5, recursive: true })
  );
  const execution = await startTestExecution({ directory, models });
  const fixture = await authoringFixture({ execution });
  const sent = await fixture.service.send(fixture.module.id, {
    binding: fixture.binding,
    prompt: "Remember me",
    source: fixture.details.source,
  });
  await settledTurn(fixture, fixture.module.id, sent.id);
  const run = execution.runs
    .list()
    .find((candidate) => candidate.correlation.turnId === sent.id);
  const sessionId = run?.correlation.agentSessionId ?? "";
  const files = await readdir(path.join(directory, "sessions"));
  const stored = files.find((file) => file.startsWith(sessionId));
  expect(stored).toBeDefined();
  expect(
    await readFile(path.join(directory, "sessions", String(stored)), "utf8")
  ).toContain("Remember me");
});

it("fails a turn that reaches its deadline, naming the limit", async () => {
  const { models } = scriptedModels([{ hold: true }]);
  const execution = await startTestExecution({ models });
  const fixture = await authoringFixture({
    execution,
    service: { deadlineMs: 50 },
  });
  const sent = await fixture.service.send(fixture.module.id, {
    binding: fixture.binding,
    prompt: "Never ends",
    source: fixture.details.source,
  });
  const turn = await settledTurn(fixture, fixture.module.id, sent.id);
  expect(turn).toMatchObject({ status: "failed" });
  expect(turn.error).toContain("minute limit");
});

it("refuses acceptance when saved source moved, keeping the proposal", async () => {
  const fixture = await authoringFixture({
    execution: inlineExecution,
    runner: async ({ container }) => {
      await container.files.writeFile(`/workspace/${APP}`, "agent");
    },
  });
  const { binding, details, library, module, service } = fixture;
  const sent = await service.send(module.id, {
    binding,
    prompt: "Edit",
    source: details.source,
  });
  await settledTurn(fixture, module.id, sent.id);
  const ready = await service.accept(module.id, sent.id);
  expect(ready).toEqual({
    base: { [APP]: details.source[APP] },
    proposal: { [APP]: "agent" },
    status: "ready",
  });

  await library.saveSource(
    module.id,
    { ...details.source, "README.md": "saved meanwhile" },
    binding
  );
  const stale = await service.accept(module.id, sent.id);
  expect(stale.status).toBe("stale");
  const { turns } = await service.conversation(module.id);
  expect(turns[0]?.proposal?.status).toBe("pending");
  // Still inspectable for comparison.
  expect((await service.proposal(module.id, sent.id)).proposal).toEqual({
    [APP]: "agent",
  });
});

it("rejects proposals that break the Manifest or the source limits", async () => {
  const fixture = await authoringFixture({
    execution: inlineExecution,
    runner: async ({ container, prompt }) => {
      if (prompt === "manifest") {
        await container.files.writeFile("/workspace/foundry.module.json", "{");
      } else {
        await container.files.writeFile(
          "/workspace/big.txt",
          "x".repeat(4_194_305)
        );
      }
    },
  });
  const { binding, details, module, service } = fixture;
  for (const [prompt, message] of [
    ["manifest", "foundry.module.json is not a valid Manifest"],
    ["size", "UTF-16 code units"],
  ] as const) {
    const sent = await service.send(module.id, {
      binding,
      prompt,
      source: details.source,
    });
    const turn = await settledTurn(fixture, module.id, sent.id);
    expect(turn.status).toBe("failed");
    expect(turn.error).toContain(message);
    expect(turn.proposal).toBeUndefined();
  }
});

it("restores proposals and reports unfinished work as interrupted after a restart", async () => {
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  const fixture = await authoringFixture({
    execution: inlineExecution,
    runner: async ({ container, prompt, question, signal }) => {
      if (prompt === "edit") {
        await container.files.writeFile(`/workspace/${APP}`, "agent");
        return;
      }
      await released;
      await question({
        questions: [{ id: "q", question: "Continue?" }],
        sessionId: "s",
        signal,
        toolCallId: "ask-1",
      });
    },
  });
  const { binding, details, module, service } = fixture;
  const edited = await service.send(module.id, {
    binding,
    prompt: "edit",
    source: details.source,
  });
  await settledTurn(fixture, module.id, edited.id);
  const asking = await service.send(module.id, {
    binding,
    prompt: "ask",
    source: details.source,
  });
  await settledTurn(
    fixture,
    module.id,
    asking.id,
    (current) => current.status === "running"
  );
  release();
  await settledTurn(fixture, module.id, asking.id, (current) =>
    current.items.some((item) => item.kind === "question")
  );

  // A new process over the same authoring state.
  const restarted = fixture.open();
  const { turns } = await restarted.conversation(module.id);
  const [first, second] = turns;
  expect(first).toMatchObject({
    id: edited.id,
    proposal: { paths: [APP], status: "pending" },
    status: "complete",
  });
  expect(second).toMatchObject({ id: asking.id, status: "interrupted" });
  expect(second?.items).toContainEqual(
    expect.objectContaining({ kind: "question", status: "interrupted" })
  );
  await expect(
    restarted.answer(module.id, asking.id, "ask-1", {
      answers: { q: ["yes"] },
      kind: "answer",
    })
  ).rejects.toThrow("no longer waiting");
  expect((await restarted.accept(module.id, edited.id)).status).toBe("ready");
  await restarted.settleProposal(module.id, edited.id, "applied");

  const again = fixture.open();
  const reopened = await again.conversation(module.id);
  expect(reopened.turns[0]?.proposal?.status).toBe("applied");
  await expect(again.accept(module.id, edited.id)).rejects.toThrow(
    "no longer waiting for review"
  );
});

it("keeps the Draft snapshot with the turn before the agent runs", async () => {
  let seen: string | undefined;
  const fixture = await authoringFixture({
    execution: inlineExecution,
    runner: async ({ container }) => {
      seen = new TextDecoder().decode(
        await container.files.readFile(`/workspace/${APP}`)
      );
    },
  });
  const { binding, details, directory, module, service } = fixture;
  const draft = { ...details.source, [APP]: "draft text" };
  const sent = await service.send(module.id, {
    binding,
    prompt: "Look",
    source: draft,
  });
  const snapshot = JSON.parse(
    await readFile(
      path.join(
        directory,
        moduleDirectory(module.id),
        "turns",
        `${sent.id}.snapshot.json`
      ),
      "utf8"
    )
  );
  expect(snapshot.source[APP]).toBe("draft text");
  await settledTurn(fixture, module.id, sent.id);
  expect(seen).toBe("draft text");
});

it("starts a new Agent Session and says so when the provider changes", async () => {
  let provider = "first";
  const sessions: string[] = [];
  const fixture = await authoringFixture({
    execution: inlineExecution,
    models: { route: () => ({ model: `${provider}/m`, provider }) },
    runner: async ({ sessionId }) => {
      sessions.push(sessionId);
    },
  });
  const { binding, details, module, service } = fixture;
  const send = async () => {
    const sent = await service.send(module.id, {
      binding,
      prompt: "Hello",
      source: details.source,
    });
    return await settledTurn(fixture, module.id, sent.id);
  };
  const first = await send();
  const second = await send();
  provider = "second";
  const third = await send();
  expect(sessions[0]).toBe(sessions[1]);
  expect(sessions[2]).not.toBe(sessions[1]);
  expect(first.notice).toBeUndefined();
  expect(second.notice).toBeUndefined();
  expect(third.notice).toBe(
    "The model provider changed from first to second, so this request starts a new conversation."
  );
  // The conversation keeps its session across a restart of the service.
  const reopened = fixture.open();
  const again = await reopened.send(module.id, {
    binding,
    prompt: "Again",
    source: details.source,
  });
  await settledTurn({ service: reopened }, module.id, again.id);
  expect(sessions[3]).toBe(sessions[2]);
  expect(again.notice).toBeUndefined();
});

it("routes a live approval to the owning chat", async () => {
  const fixture = await authoringFixture({
    execution: inlineExecution,
    runner: async ({ approve, signal }) => {
      const decision = await approve({
        approvalId: "approval-1",
        capability: { kind: "tool.call", source: "builtin", tool: "bash" },
        input: { command: "rm -rf /" },
        inputSummary: "fields: command",
        sessionId: "s",
        signal,
        toolCallId: "call-1",
        toolName: "bash",
      });
      if (decision.approved) {
        throw new Error("Expected a denial");
      }
    },
  });
  const { binding, details, module, service } = fixture;
  const sent = await service.send(module.id, {
    binding,
    prompt: "Try something",
    source: details.source,
  });
  const waiting = await settledTurn(fixture, module.id, sent.id, (current) =>
    current.items.some((item) => item.kind === "approval")
  );
  expect(waiting.items).toContainEqual({
    id: "approval-1",
    kind: "approval",
    status: "open",
    summary: "fields: command",
    toolName: "bash",
  });
  await expect(
    service.answer(module.id, sent.id, "approval-1", {
      answers: {},
      kind: "answer",
    })
  ).rejects.toThrow("does not fit");
  await service.answer(module.id, sent.id, "approval-1", {
    approved: false,
    kind: "approval",
  });
  const turn = await settledTurn(fixture, module.id, sent.id);
  expect(turn.status).toBe("complete");
  expect(turn.items[0]).toMatchObject({ kind: "approval", status: "answered" });
});

it("cancels the questions of a cancelled turn", async () => {
  const fixture = await authoringFixture({
    execution: inlineExecution,
    runner: ({ question, signal }) =>
      question({
        questions: [{ id: "q", question: "Wait?" }],
        sessionId: "s",
        signal,
        toolCallId: "ask-1",
      }).then(() => undefined),
  });
  const { binding, details, module, service } = fixture;
  const sent = await service.send(module.id, {
    binding,
    prompt: "Ask",
    source: details.source,
  });
  await settledTurn(fixture, module.id, sent.id, (current) =>
    current.items.some((item) => item.kind === "question")
  );
  await service.cancel(module.id, sent.id);
  const turn = await settledTurn(fixture, module.id, sent.id);
  expect(turn.status).toBe("cancelled");
  expect(turn.items[0]).toMatchObject({
    kind: "question",
    status: "cancelled",
  });
});

it("applies the Module's settings: step limit, lowered source limits, unmet requirements", async () => {
  const seen: number[] = [];
  const limits = vi.fn((_moduleId: string) =>
    Promise.resolve({
      deadlineMs: 60_000,
      maxSteps: 7,
      source: { ...SOURCE_LIMITS, maxFileCodeUnits: 1000 },
    })
  );
  const fixture = await authoringFixture({
    execution: inlineExecution,
    runner: async ({ container, maxSteps, prompt }) => {
      seen.push(maxSteps);
      if (prompt === "big") {
        await container.files.writeFile("/workspace/big.txt", "x".repeat(1001));
      }
    },
    service: { limits },
  });
  const { binding, details, module, service } = fixture;
  const small = Object.fromEntries(
    Object.entries(details.source).filter(([, text]) => text.length <= 1000)
  );

  const sent = await service.send(module.id, {
    binding,
    prompt: "big",
    source: small,
  });
  const turn = await settledTurn(fixture, module.id, sent.id);
  expect(limits).toHaveBeenCalledWith(module.id);
  expect(seen).toEqual([7]);
  expect(turn.status).toBe("failed");
  expect(turn.error).toContain("longer than 1000 UTF-16 code units");

  // The Draft itself is admitted under the lowered limits too.
  await expect(
    service.send(module.id, {
      binding,
      prompt: "x",
      source: { ...small, "big.txt": "x".repeat(1001) },
    })
  ).rejects.toThrow("longer than 1000 UTF-16 code units");

  limits.mockRejectedValueOnce(new Error("Module settings cannot be met"));
  await expect(
    service.send(module.id, { binding, prompt: "x", source: small })
  ).rejects.toThrow("Module settings cannot be met");
});

it("proposes a Module's own builds/ folder like any other source", async () => {
  const fixture = await authoringFixture({
    execution: inlineExecution,
    runner: async ({ container }) => {
      await container.files.copyIn({
        "/workspace/builds/plan.md": "# Build plan\n",
      });
    },
  });
  const { binding, details, module, service } = fixture;
  const sent = await service.send(module.id, {
    binding,
    prompt: "Write the build plan",
    source: { ...details.source, "builds/notes.md": "kept" },
  });
  await settledTurn(fixture, module.id, sent.id);
  // Seeded and collected like the rest of the Draft: nothing under builds/
  // is skipped, and the untouched file is no change.
  expect((await service.proposal(module.id, sent.id)).proposal).toEqual({
    "builds/plan.md": "# Build plan\n",
  });
});
