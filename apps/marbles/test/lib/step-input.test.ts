import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { step } from "~/authoring/builder";
import { agent } from "~/authoring/resources";
import { commandRunner } from "~/lib/command";
import type { Engine } from "~/lib/engine";
import type { LiveWork } from "~/lib/step-work";
import { StepInputError, StepWork } from "~/lib/step-work";
import type { SandboxHandle } from "~/lib/types";
import { bindMock } from "../helpers/bindings";
import { startEngine } from "../helpers/engine";

const NOT_RUNNING = /not running here/;
const NOT_LIVE = /no longer live/;

const GREETER = [
  'process.stdout.write("name? ");',
  'process.stdin.once("data", (data) => {',
  '  process.stdout.write("hello " + String(data).trim() + "\\n");',
  "  process.exit(0);",
  "});",
].join("\n");

let root: string;
let engine: Engine | undefined;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "marbles-step-input-")));
});

afterEach(async () => {
  await engine?.stop();
  engine = undefined;
  await rm(root, { force: true, recursive: true });
});

async function eventually<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error("timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function liveIn(host: Engine, runId: string): LiveWork | undefined {
  return host.scopes.get(runId)?.work()[0];
}

describe("input to live work in a step", () => {
  it("a command started in a step takes a line of input through the step and finishes", async () => {
    const greet = step("greet").do(async ({ exec }) => {
      const result = await exec([process.execPath, "-e", GREETER]);
      return result.stdout;
    });
    engine = await startEngine({
      collect: [greet],
      print: () => undefined,
      root,
    });
    const launched = await engine.launch<string>("greet", {});
    const live = await eventually(() => liveIn(engine as Engine, launched.id));
    expect(live).toMatchObject({
      input: "stdin",
      kind: "command",
      pid: expect.any(Number),
      stepId: "greet",
    });
    engine.send(launched.id, "greet", { target: live.id, text: "Ada" });
    await expect(launched.result).resolves.toBe("name? hello Ada\n");
    expect(engine.scopes.get(launched.id)?.work() ?? []).toEqual([]);
  });

  it("refuses input once the command has ended, and for a run that is not here", async () => {
    const quick = step("quick").do(({ exec }) => exec(["true"]));
    engine = await startEngine({
      collect: [quick],
      print: () => undefined,
      root,
    });
    const launched = await engine.launch("quick", {});
    await launched.result;
    expect(() =>
      engine?.send(launched.id, "quick", { target: "gone", text: "x" })
    ).toThrow(NOT_RUNNING);
    expect(() =>
      engine?.send("elsewhere", "quick", { target: "gone", text: "x" })
    ).toThrow(NOT_RUNNING);
  });

  it("leaving the stream does not stop the command, and input still reaches it", async () => {
    const greet = step("greet").do(async ({ exec }) => {
      const result = await exec([process.execPath, "-e", GREETER]);
      return result.stdout;
    });
    engine = await startEngine({
      collect: [greet],
      print: () => undefined,
      root,
    });
    const launched = await engine.launch<string>("greet", {});
    const live = await eventually(() => liveIn(engine as Engine, launched.id));
    const attached = new AbortController();
    const reader = engine.stream(launched.id, attached.signal)?.getReader();
    await reader?.read();
    attached.abort();
    await reader?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(liveIn(engine, launched.id)?.id).toBe(live.id);
    engine.send(launched.id, "greet", { target: live.id, text: "Grace" });
    await expect(launched.result).resolves.toBe("name? hello Grace\n");
  });

  it("pausing a step still stops its command, and input aimed at it is refused", async () => {
    const greet = step("greet").do(async ({ exec }) => {
      const result = await exec([process.execPath, "-e", GREETER]);
      return result.stdout;
    });
    engine = await startEngine({
      collect: [greet],
      print: () => undefined,
      root,
    });
    const launched = await engine.launch<string>("greet", {});
    const live = await eventually(() => liveIn(engine as Engine, launched.id));
    expect(engine.pause(launched.id, "greet", "hold")).toBe(true);
    await eventually(() =>
      liveIn(engine as Engine, launched.id) === undefined ? true : undefined
    );
    expect(() =>
      engine?.send(launched.id, "greet", { target: live.id, text: "late" })
    ).toThrow(NOT_LIVE);
    await engine.cancel(launched.id);
  });

  it("a sandbox command is shown live but never claims to take input", async () => {
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const sandbox = {
      exec: async () => {
        await held;
        return { exitCode: 0, stderr: "", stdout: "done" };
      },
    } as unknown as SandboxHandle;
    const work = new StepWork("remote");
    const exec = commandRunner({
      cwd: () => root,
      print: () => undefined,
      signal: () => undefined,
      work,
    });
    const running = exec(["make", "test"], { sandbox });
    const [live] = work.list();
    expect(live).toMatchObject({
      command: "make test",
      input: "none",
      kind: "command",
      stepId: "remote",
    });
    let refusal: unknown;
    try {
      work.send({ target: live?.id ?? "", text: "y" });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(StepInputError);
    expect((refusal as StepInputError).code).toBe("no-input");
    finish();
    await expect(running).resolves.toMatchObject({ stdout: "done" });
    expect(work.list()).toEqual([]);
  });

  it("an agent turn in a step is live work that a person can steer by its id", async () => {
    const mock = bindMock(
      ({ prompt }) => `reply to ${prompt.split("\n").at(-1) ?? ""}`,
      { hold: ({ prompt }) => prompt.endsWith("count slowly"), root }
    );
    const reviewer = agent({ prompt: "Review." });
    const review = step("review").do(async ({ agents }) => {
      const session = await agents.session(reviewer);
      const reply = await session.generate("count slowly");
      return reply.text;
    });
    engine = await startEngine({
      ...mock.instances,
      collect: [reviewer, review],
      print: () => undefined,
      root,
    });
    const launched = await engine.launch<string>("review", {});
    const live = await eventually(() => liveIn(engine as Engine, launched.id));
    expect(live).toMatchObject({
      agent: expect.any(String),
      input: "steer",
      kind: "agent",
      sessionId: expect.any(String),
      stepId: "review",
    });
    engine.send(launched.id, "review", {
      target: live.id,
      text: "stop and summarise",
    });
    await expect(launched.result).resolves.toBe("reply to stop and summarise");
    expect(engine.scopes.get(launched.id)?.work() ?? []).toEqual([]);
    await mock.dispose();
  });
});
