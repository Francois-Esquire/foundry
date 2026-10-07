import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayProvider } from "@foundry/models/gateway";
import { afterEach, expect, it } from "vitest";
import { step } from "~/authoring/builder";
import { catalog } from "~/authoring/catalog";
import { createEngine } from "~/create";
import { dashboardSnapshot } from "~/dashboard/snapshot";
import { AutomationService } from "~/lib/automation/service";
import { tick } from "~/lib/schedule";
import { JsonStateStore } from "~/lib/state/store";
import { declared } from "../helpers/engine";

afterEach(() => {
  catalog.reset();
});
for (const harness of ["builtin", "claude-code", "codex"] as const) {
  it(`${harness} exposes real child activity and creates a durable schedule through MicroSandbox`, async () => {
    const parent = await mkdtemp(
      join(tmpdir(), `marbles-activity-${harness}-`)
    );
    const root = join(parent, "workspace");
    const state = join(parent, "state");
    await mkdir(root);
    const marker = `answer-${crypto.randomUUID()}`;
    const nativeMarker = `native-${crypto.randomUUID()}`;
    await writeFile(join(root, "evidence.txt"), nativeMarker);
    let fired = 0;
    step("automation-proof").do(async () => {
      fired += 1;
      await writeFile(join(root, "scheduled.txt"), "ran");
      return "ran";
    });
    const engine = createEngine({
      askable: true,
      catalog,
      dry: false,
      only: [],
      print: () => undefined,
      providers:
        harness === "builtin"
          ? [
              gatewayProvider({
                config: {
                  apiKey: process.env.AI_GATEWAY_API_KEY,
                  baseURL: "https://ai-gateway.vercel.sh/v1",
                },
              }),
            ]
          : [],
      root,
      stateDir: state,
      workspaceId: `activities-${harness}`,
    });
    const model = {
      builtin: "openai/gpt-5-mini",
      "claude-code": "sonnet",
      codex: "gpt-5.5",
    }[harness];
    let nativeReply = "";
    let nativePhase = false;
    let nativeApprovals = 0;
    let parentReply = "";
    let bodyCount = 0;
    step("activity-coding").do(async ({ agents, sandboxes }) => {
      bodyCount += 1;
      const sandbox = await sandboxes.start({
        executable: true,
        image: "docker.io/oven/bun:1-slim",
        network:
          harness === "builtin"
            ? "disabled"
            : {
                destinations: [
                  {
                    host:
                      harness === "claude-code"
                        ? "api.anthropic.com"
                        : "chatgpt.com",
                    ports: [443],
                  },
                ],
                mode: "allowlist",
              },
      });
      const session = await agents.session(
        {
          id: `activity-${harness}`,
          kind: "agent",
          model,
          prompt:
            "Follow the requested tool sequence exactly. Tools prefixed mcp__foundry__ are the host-provided tools. Never create schedules using shell commands. Use the delegate host tool when specifically requested. Do not guess a user's answer.",
          provider: harness === "builtin" ? "gateway" : harness,
        },
        {
          profile: {
            allowedTools: [
              "Read",
              "Glob",
              "Grep",
              "Edit",
              "Write",
              "read",
              "glob",
              "grep",
              "Agent",
              "Task",
              "delegate",
              "list_automation_targets",
              "list_automations",
              "create_automation",
            ],
            disallowedTools: [],
            maxSteps: 16,
            mode: "attended",
            unresolved: "ask",
          },
          sandbox,
        }
      );
      parentReply = (
        await session.generate(
          'You must call the host delegate tool, not ask_user yourself. If delegate fails, report its error and stop without asking the question yourself. Call delegate with title "Ask reviewer" and task "Use ask_user (or AskUserQuestion) to ask the user for the review marker, then return that marker verbatim. Do not read files or execute commands." Wait for the child. Then use create_automation to create a schedule with key "review-reminder", workflow "automation-proof", input {}, and at "1h". Return the child marker and automation id. Do not use a native scheduling tool.',
          { signal: AbortSignal.timeout(180_000) }
        )
      ).text;
      if (harness !== "builtin") {
        nativePhase = true;
        nativeReply = (
          await session.generate(
            "Now use your NATIVE subagent tool, Agent/Task or spawn_agent, to delegate this task: use the shell tool to run bun -e to read /workspace/evidence.txt and write its exact contents into /workspace/native-result.txt, then report those contents. Do not use file-edit tools. Do not use the host delegate tool. Use foreground delegation, explicitly run_in_background false for Agent/Task. Use native wait or TaskOutput until the subagent has actually finished. Do not end your parent turn while the child is still running. Return the exact contents it found. The parent must not read the file itself.",
            { signal: AbortSignal.timeout(180_000) }
          )
        ).text;
      }
      return parentReply;
    });
    await engine.start();
    let passed = false;
    let settled = false;
    let failure: unknown;
    let questions = 0;
    try {
      const launch = await engine.launch("activity-coding", {});
      launch.result.then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          failure = error;
          settled = true;
        }
      );
      const deadline = Date.now() + 400_000;
      while (!settled && Date.now() < deadline) {
        const entry = (await engine.feed()).find(
          (item) => item.input?.status === "open"
        );
        if (entry?.input?.mode === "question") {
          expect(
            entry.input.activityId,
            JSON.stringify(
              engine.activities.list().map(({ event }) => ({
                kind: event.kind,
                status: event.status,
                title: event.title,
              }))
            )
          ).toBeTruthy();
          const activity = engine.activities
            .list()
            .find((item) => item.event.id === entry.input?.activityId);
          expect(activity?.event.kind).toBe("subagent");
          questions += 1;
          if (entry.input.choices.length) {
            await engine.answer(entry.id, "Write another answer");
          }
          await engine.answer(entry.id, marker);
        } else if (entry?.input?.mode === "approval") {
          if (nativePhase) {
            expect(entry.input.activityId).toBeTruthy();
            nativeApprovals += 1;
          }
          await engine.answer(entry.id, "Approve once");
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!settled) {
        throw new Error("Activity fixture timed out");
      }
      if (failure) {
        throw failure;
      }
      await launch.result;
      expect(questions).toBe(1);
      expect(parentReply).toContain(marker);
      expect(bodyCount).toBe(1);
      const activities = engine.activities.list();
      expect(
        activities.some(
          (record) =>
            record.event.kind === "subagent" &&
            record.event.status === "complete"
        )
      ).toBe(true);
      if (harness !== "builtin") {
        expect(nativeReply).toContain(nativeMarker);
        expect(nativeApprovals).toBeGreaterThan(0);
        expect(await readFile(join(root, "native-result.txt"), "utf8")).toBe(
          nativeMarker
        );
        expect(
          activities.some(
            (record) =>
              record.event.nativeId &&
              record.event.kind === "subagent" &&
              record.event.status === "complete"
          )
        ).toBe(true);
      }
      const [automation] = engine.automations.list();
      expect(automation?.workflow).toBe("automation-proof");
      expect(fired).toBe(0);
      const snapshot = dashboardSnapshot(await engine.runs(), {
        activities,
        automations: engine.automations.list(),
        definitions: engine.definitions(),
        feed: await engine.feed(),
        lastFinish: new Map(),
        monitors: engine.monitors(),
        root,
        schedules: engine.schedules(),
        startedAt: Date.now(),
        status: "ready",
      });
      expect(
        snapshot.runs.find((run) => run.id === launch.id)?.activities?.length
      ).toBeGreaterThan(0);
      expect(
        snapshot.triggers.find((trigger) => trigger.id === automation?.id)
          ?.managed
      ).toBe(true);
      const restored = new AutomationService({
        registry: declared(),
        store: new JsonStateStore(state),
      });
      const schedule = restored
        .schedules()
        .find((item) => item.key === automation?.id);
      expect(schedule).toBeDefined();
      if (!schedule) {
        throw new Error("Missing restored schedule");
      }
      await tick(engine, schedule, { print: () => undefined });
      expect(fired).toBe(1);
      expect(await readFile(join(root, "scheduled.txt"), "utf8")).toBe("ran");
      restored.setEnabled(schedule.key, false);
      expect(
        restored.schedules().some((item) => item.key === schedule.key)
      ).toBe(false);
      restored.delete(schedule.key);
      expect(
        new AutomationService({
          registry: declared(),
          store: new JsonStateStore(state),
        }).list()
      ).toHaveLength(0);
      passed = true;
    } finally {
      await engine.stop({ cancel: true });
      await engine.dispose();
      if (passed) {
        await rm(parent, { force: true, recursive: true });
      }
    }
  }, 600_000);
}
