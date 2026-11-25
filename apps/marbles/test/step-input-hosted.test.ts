import type { ChannelMessage } from "@foundry/workflows/channels";
import { describe, expect, it, vi } from "vitest";
import type { LiveWork } from "~/lib/step-work";
import type { WorkspaceConnection } from "~/model/connection";
import type { StepSnapshot } from "~/model/dashboard";
import {
  generationFiles,
  gone,
  startSwitchingWorkspace,
  switchFrom,
} from "./helpers/generation-switch";
import { testHome } from "./helpers/home";

const TIMEOUT = 120_000;

const GREETER = [
  'process.stdout.write("name? ");',
  'process.stdin.once("data", (data) => {',
  '  process.stdout.write("hello " + String(data).trim() + " from OWNER\\n");',
  "  process.exit(0);",
  "});",
].join("\n");

function moduleText(revision: number): string {
  return [
    'import { step } from "@foundry.sh/marbles";',
    'export const greet = step("greet").do(async ({ exec }) => {',
    `  const script = ${JSON.stringify(GREETER)}.replace("OWNER", String(process.pid));`,
    '  const result = await exec([process.execPath, "-e", script]);',
    "  return result.stdout;",
    "});",
    `export const revision = ${String(revision)};`,
    "",
  ].join("\n");
}

async function hosted() {
  const fixture = generationFiles(testHome({ providers: false }));
  const started = await startSwitchingWorkspace(fixture, moduleText(0));
  return {
    ...started,
    workspace: started.client.workspace(started.summary),
  };
}

function stepsOf(steps: readonly StepSnapshot[]): StepSnapshot[] {
  return steps.flatMap((step) => [step, ...stepsOf(step.children)]);
}

async function liveCommand(
  workspace: WorkspaceConnection,
  runId: string
): Promise<LiveWork> {
  return await vi.waitFor(
    async () => {
      const run = (await workspace.snapshot()).runs.find(
        (each) => each.id === runId
      );
      const work = stepsOf(run?.steps ?? []).flatMap((step) => step.work ?? []);
      const [command] = work.filter((each) => each.kind === "command");
      expect(command).toMatchObject({ input: "stdin", kind: "command" });
      return command as LiveWork;
    },
    { interval: 100, timeout: 30_000 }
  );
}

async function readUntil(
  workspace: WorkspaceConnection,
  runId: string,
  stepId: string,
  wanted: string,
  times = 1
): Promise<string> {
  const attached = new AbortController();
  const stream = workspace.actions.runs.stream?.(runId, attached.signal);
  expect(stream).toBeDefined();
  const reader = (stream as ReadableStream<ChannelMessage>).getReader();
  let text = "";
  try {
    while (text.split(wanted).length <= times) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value._tag === "chunk" && value.chunk.payload.kind === "text") {
        expect(value.chunk.path.join(".")).toBe(stepId);
        text += value.chunk.payload.text;
      }
    }
  } finally {
    attached.abort();
    await reader.cancel().catch(() => undefined);
  }
  expect(text.split(wanted).length).toBeGreaterThan(times);
  return text;
}

async function finished(
  workspace: WorkspaceConnection,
  runId: string
): Promise<unknown> {
  return await vi.waitFor(
    async () => {
      const info = await workspace.getRun(runId);
      expect(info.status).toBe("completed");
      return info.output;
    },
    { interval: 100, timeout: 30_000 }
  );
}

describe("a command live in a hosted step", () => {
  it(
    "shows its prompt in the step's stream, takes a line, and goes on after the stream is left",
    async () => {
      const fixture = await hosted();
      const { workspace } = fixture;
      const pid = fixture.summary.pid ?? 0;
      const runId = await workspace.actions.launch("greet", {});
      const command = await liveCommand(workspace, runId);

      await readUntil(workspace, runId, command.stepId, "name? ");
      await workspace.actions.runs.send(runId, command.stepId, {
        target: command.id,
        text: "Ada",
      });

      expect(await finished(workspace, runId)).toBe(
        `name? hello Ada from ${String(pid)}\n`
      );
      const replay = await readUntil(
        workspace,
        runId,
        command.stepId,
        "hello Ada"
      );
      expect(replay).toContain("[stdin] sent a line");
      fixture.client.close();
    },
    TIMEOUT
  );

  it(
    "after a pause and resume, the replayed command shows its prompt again and takes the line",
    async () => {
      const fixture = await hosted();
      const { workspace } = fixture;
      const runId = await workspace.actions.launch("greet", {});
      const first = await liveCommand(workspace, runId);
      await readUntil(workspace, runId, first.stepId, "name? ");
      await workspace.actions.runs.pause(runId, first.stepId);
      await workspace.actions.runs.resume(runId, first.stepId);
      const replayed = await vi.waitFor(
        async () => {
          const command = await liveCommand(workspace, runId);
          expect(command.id).not.toBe(first.id);
          return command;
        },
        { interval: 100, timeout: 30_000 }
      );
      await readUntil(workspace, runId, replayed.stepId, "name? ", 2);
      await workspace.actions.runs.send(runId, replayed.stepId, {
        target: replayed.id,
        text: "Lin",
      });
      expect(await finished(workspace, runId)).toContain("hello Lin");
      fixture.client.close();
    },
    TIMEOUT
  );

  it(
    "stays reachable on the generation that owns it after a reload: listed, streamed and answered there",
    async () => {
      const fixture = await hosted();
      const { workspace } = fixture;
      const first = fixture.summary.pid ?? 0;
      const runId = await workspace.actions.launch("greet", {});
      const before = await liveCommand(workspace, runId);

      const second = await switchFrom(fixture, first, 1, moduleText(1));
      expect(second).not.toBe(first);
      const after = await liveCommand(workspace, runId);
      expect(after).toEqual(before);

      await readUntil(workspace, runId, after.stepId, "name? ");
      await workspace.actions.runs.send(runId, after.stepId, {
        target: after.id,
        text: "Grace",
      });
      await gone(first);
      expect(await finished(workspace, runId)).toBe(
        `name? hello Grace from ${String(first)}\n`
      );
      fixture.client.close();
    },
    TIMEOUT
  );
});
