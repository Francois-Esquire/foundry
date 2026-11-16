import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Output } from "ai";
import { serve } from "bun";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { step } from "~/authoring/builder";
import { Catalog, catalog } from "~/authoring/catalog";
import { observe } from "~/authoring/observe";
import { agent } from "~/authoring/resources";
import { dispose, setHost } from "~/authoring/runtime";
import { tasks } from "~/authoring/tasks";
import type { StepRecord } from "~/lib/definition";
import type { Engine } from "~/lib/engine";
import { activeContext } from "~/lib/execution-context";
import { BackgroundRuns } from "~/workspace/background-runs";
import { hostTasks } from "~/workspace/open";
import { startEngine } from "./helpers/engine";
import { seedRepository } from "./helpers/repository";

afterEach(async () => {
  await dispose();
  catalog.reset();
});

const ANSWER = '{"answer":1}';

it("runs every author function as its engine's work, through every public entry", async () => {
  let engine: Engine | undefined;
  let entry = "setup";
  const heard: { entry: string; fn: string; own: boolean }[] = [];
  const probe = (fn: string) => {
    heard.push({ entry, fn, own: activeContext() === engine?.context });
  };
  const schema = (fn: string): StandardSchemaV1 => ({
    "~standard": {
      validate: (value: unknown) => {
        probe(fn);
        return { value };
      },
      vendor: "test",
      version: 1,
    },
  });

  const recipe = agent(() => {
    probe("agent builder");
    return {
      prompt: "Answer.",
      settings: {
        output: Output.object({
          schema: z.object({ answer: z.number() }).refine(() => {
            probe("agent output schema");
            return true;
          }),
        }),
      },
    };
  });
  const generate = (input: string) =>
    (recipe as unknown as { generate(i: string): Promise<unknown> }).generate(
      input
    );
  observe(tasks, () => {
    probe("observer");
  });
  const direct = step("direct").do(() => {
    probe("step body called directly");
    return "direct";
  });

  const server = serve({ fetch: () => new Response("polled"), port: 0 });
  const root = await seedRepository();
  writeFileSync(join(root, "notes.md"), "hello");
  mkdirSync(join(root, "state"), { recursive: true });
  engine = await startEngine({
    git: {},
    print: () => undefined,
    reply: () => ANSWER,
    root,
    workspaceId: "every-entry",
  });
  const own = new Catalog();
  own.agents.set(recipe.id, recipe as never);
  setHost(engine, own);
  const runs = new BackgroundRuns(engine, own);

  engine.task({
    name: "entry-task",
    run: async (_input, context) => {
      probe("task body");
      const session = await context.agents.session(recipe as never);
      await session.generate(ANSWER);
      return "task";
    },
  });
  let attempts = 0;
  const child: StepRecord = {
    config: {
      retry: {
        maxAttempts: 2,
        shouldRetry: () => {
          probe("retry decision");
          return true;
        },
      },
    },
    fn: async () => {
      probe("step body");
      attempts += 1;
      if (attempts === 1) {
        throw new Error("the first attempt fails");
      }
      await generate(ANSWER);
      return 1;
    },
    input: schema("step input schema"),
    kind: "step",
    name: "child",
    output: schema("step output schema"),
  };
  const parent: StepRecord = {
    fn: () => "flow",
    kind: "step",
    name: "parent",
  };
  engine.define({
    input: schema("launch input schema"),
    kind: "workflow",
    name: "entry-flow",
    setup: () => {
      probe("workflow setup");
      return {
        children: [
          [
            "child",
            {
              children: [],
              definition: child,
              kind: "node",
              literal: {},
              mode: "series",
            },
          ],
        ],
        definition: parent,
        kind: "node",
        literal: {},
        mode: "series",
      };
    },
  });
  engine.monitor({
    handler: () => {
      probe("file monitor handler");
    },
    key: "entry-files",
    source: { glob: "*.md", kind: "files" },
    trigger: { kind: "interval", ms: 60_000 },
  });
  engine.monitor({
    handler: () => {
      probe("http monitor handler");
    },
    key: "entry-http",
    request: () => {
      probe("monitor request");
      return {};
    },
    source: { kind: "http", url: `http://localhost:${String(server.port)}/` },
    trigger: { kind: "interval", ms: 60_000 },
  });

  try {
    entry = "task";
    await engine.run("entry-task", undefined);

    entry = "launch";
    await engine.run("entry-flow", undefined);

    entry = "background dispatch";
    await runs.start({ agent: recipe.id, prompt: ANSWER });
    await vi.waitFor(() =>
      expect(
        heard.some(
          (each) =>
            each.entry === "background dispatch" &&
            each.fn === "agent output schema"
        )
      ).toBe(true)
    );

    entry = "outside a run";
    await generate(ANSWER);
    await direct.run();
    await engine.workspaces.current.git.withWorktree(
      { base: "main" },
      async () => {
        probe("worktree callback");
      }
    );

    entry = "observer";
    await hostTasks(engine).create({ title: "observed" });
    await vi.waitFor(() =>
      expect(heard.some((each) => each.fn === "observer")).toBe(true)
    );

    entry = "monitor tick";
    await engine.run("entry-files", {});
    await engine.run("entry-http", {});

    const called = (where: string) =>
      [
        ...new Set(
          heard.filter((each) => each.entry === where).map((each) => each.fn)
        ),
      ].sort();
    expect({
      dispatch: called("background dispatch"),
      launch: called("launch"),
      monitor: called("monitor tick"),
      observer: called("observer"),
      outside: called("outside a run"),
      task: called("task"),
    }).toEqual({
      dispatch: ["agent builder", "agent output schema"],
      launch: [
        "agent builder",
        "agent output schema",
        "launch input schema",
        "retry decision",
        "step body",
        "step input schema",
        "step output schema",
        "workflow setup",
      ],
      monitor: [
        "file monitor handler",
        "http monitor handler",
        "monitor request",
      ],
      observer: ["observer"],
      outside: [
        "agent builder",
        "agent output schema",
        "step body called directly",
        "worktree callback",
      ],
      task: ["agent builder", "agent output schema", "task body"],
    });
    expect(heard.filter((each) => !each.own)).toEqual([]);
  } finally {
    await runs.close();
    await engine.dispose();
    await server.stop(true);
  }
}, 60_000);
