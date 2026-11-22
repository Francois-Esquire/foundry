import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactEvent } from "@foundry/artifacts";
import type {
  ArtifactShareEvent,
  CommandResult,
  LockedNode,
  StepDefinition,
} from "@foundry.sh/marbles";
import {
  agent,
  artifact,
  monitor,
  observe,
  step,
  workflow,
} from "@foundry.sh/marbles";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import { z } from "zod";
import { catalog } from "~/authoring/catalog";
import { setHost } from "~/authoring/runtime";
import type { Engine } from "~/lib/engine";
import { buildDefinition } from "~/lib/managers/agents";
import { startEngine, testEngine } from "./helpers/engine";
import type { TestMachine } from "./helpers/records";
import { testMachine } from "./helpers/records";

const HASHED_AGENT = /^agent-/;
const BLANK_AGENT = /a name cannot be blank/;
const TAKEN_AGENT = /agent "shared" already declared/;
const BLANK_MONITOR = /\.name\(\): a name cannot be blank/;
const ONE_WORD = /a name is one word/;
const MONITOR_TAKEN =
  /monitor "docs": a schedule or monitor of that name is already registered/;

const engines: Engine[] = [];
let machine: TestMachine;

beforeAll(async () => {
  machine = await testMachine();
});

afterAll(() => {
  machine.close();
});

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  catalog.reset();
});

describe("agent(name, define)", () => {
  it("names an agent declared by a function, so one helper can declare several", async () => {
    const reviewer = (team: string) =>
      agent(`reviewer-${team}`, () => ({ prompt: `Review for ${team}.` }));
    const byTeam = Object.fromEntries(
      ["web", "api"].map((team) => [team, reviewer(team)])
    );
    expect(byTeam.web?.id).toBe("reviewer-web");
    expect(byTeam.api?.id).toBe("reviewer-api");
    expect([...catalog.agents.keys()].sort()).toEqual([
      "reviewer-api",
      "reviewer-web",
    ]);
    await expect(
      buildDefinition(byTeam.api as NonNullable<typeof byTeam.api>)
    ).resolves.toMatchObject({ id: "reviewer-api", prompt: "Review for api." });
  });

  it("refuses a blank name, and one name taken by another function", () => {
    expect(() => agent("  ", () => ({ prompt: "x" }))).toThrow(BLANK_AGENT);
    agent("shared", () => ({ prompt: "one" }));
    expect(() => agent("shared", () => ({ prompt: "two" }))).toThrow(
      TAKEN_AGENT
    );
  });

  it("still takes a bare function and an object with a name", () => {
    const routed = agent(() => ({ prompt: "Route." }));
    const fixed = agent({ name: "fixed", prompt: "Fixed." });
    expect(routed.id).toMatch(HASHED_AGENT);
    expect(fixed.id).toBe("fixed");
    expect(() => agent({ name: "", prompt: "Blank." })).toThrow(BLANK_AGENT);
  });
});

describe("monitor(source).name(key)", () => {
  it("keys a monitor by the name it is given, wherever it comes in the chain", () => {
    monitor("docs/**/*.md")
      .name("docs")
      .every("5m")
      .do(() => undefined);
    monitor("https://example.test/feed")
      .request({ headers: { accept: "application/json" } })
      .name("feed")
      .do(() => undefined);
    expect([...catalog.monitors.keys()]).toEqual(["docs", "feed"]);
    expect(catalog.monitors.get("docs")?.trigger).toEqual({
      kind: "interval",
      ms: 300_000,
    });
  });

  it("refuses a blank name, one of several words, and a name already taken", () => {
    expect(() => monitor("*.md").name(" ")).toThrow(BLANK_MONITOR);
    expect(() => monitor("*.md").name("two words")).toThrow(ONE_WORD);
    monitor("*.md")
      .name("docs")
      .do(() => undefined);
    expect(() =>
      monitor("*.txt")
        .name("docs")
        .do(() => undefined)
    ).toThrow(MONITOR_TAKEN);
  });
});

describe("observe(artifact, …)", () => {
  it("types its handler for artifact and share facts alike, and is handed shares when it names their types", async () => {
    const seen: ArtifactShareEvent[] = [];
    observe(
      artifact,
      (fact) => {
        expectTypeOf(fact).toEqualTypeOf<ArtifactEvent | ArtifactShareEvent>();
        if (
          fact.type === "artifact.shared" ||
          fact.type === "artifact.unshared"
        ) {
          seen.push(fact);
        }
      },
      { name: "shares", types: ["artifact.shared", "artifact.unshared"] }
    );
    const state = machine.workspace();
    const records = machine.records(state);
    const engine = testEngine({ print: () => undefined, records, state });
    engines.push(engine);
    setHost(engine);
    await engine.start();

    const share = (type: ArtifactShareEvent["type"], id: string) => ({
      artifactId: "ar-1",
      at: new Date().toISOString(),
      id,
      type,
      workspace: "ws2",
    });
    await records.changes.record(machine.database.database, "artifacts", [
      share("artifact.shared", "fact-1"),
      share("artifact.unshared", "fact-2"),
    ]);
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen.map((each) => each.type)).toEqual([
      "artifact.shared",
      "artifact.unshared",
    ]);
  });
});

describe("step().exec(command, options)", () => {
  let root: string;

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("computes its options from the step's input", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "marbles-exec-")));
    const where = step("where-in")
      .input(z.object({ dir: z.string(), greeting: z.string() }))
      .exec("sh -c 'pwd; printf %s \"$GREETING\"'", ({ input }) => ({
        cwd: input.dir,
        environment: { GREETING: input.greeting },
      }));
    expectTypeOf(where).toEqualTypeOf<
      StepDefinition<
        { dir: string; greeting: string },
        CommandResult,
        { dir: string; greeting: string }
      >
    >();
    const engine = await startEngine({ print: () => undefined, root });
    engines.push(engine);
    await expect(
      engine.run("where-in", { dir: root, greeting: "hi" })
    ).resolves.toMatchObject({ stdout: `${root}\nhi` });
  });

  it("awaits options a function resolves later", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "marbles-exec-")));
    step("checked-later").exec("sh -c 'exit 4'", async () => {
      await Promise.resolve();
      return { check: false };
    });
    const engine = await startEngine({ print: () => undefined, root });
    engines.push(engine);
    await expect(engine.run("checked-later", {})).resolves.toMatchObject({
      exitCode: 4,
    });
  });
});

describe("locking a leaf", () => {
  it("locks a definition with no input and no children when called with nothing", async () => {
    const checks = step("checks").do(() => "checked");
    const node = checks();
    expectTypeOf(node).toEqualTypeOf<LockedNode<string>>();
    expect(node).toMatchObject({ children: [], kind: "node", literal: {} });
    const parallelNode = checks.parallel();
    const seriesNode = checks.series();
    expectTypeOf(parallelNode).toEqualTypeOf<LockedNode<string>>();
    expectTypeOf(seriesNode).toEqualTypeOf<LockedNode<string>>();
    expect(parallelNode).toMatchObject({
      children: [],
      kind: "node",
      literal: {},
      mode: "parallel",
    });
    expect(seriesNode).toMatchObject({
      children: [],
      kind: "node",
      literal: {},
      mode: "series",
    });
    const both = workflow("both", () => checks());
    const engine = await startEngine({ print: () => undefined });
    engines.push(engine);
    await expect(both.run()).resolves.toBe("checked");
  });

  it("lets workflow() take such a definition uncalled, as a function returning its node", async () => {
    const leaf = step("bare-leaf").do(() => "bare");
    const wrapped = workflow("wrapped", leaf);
    const engine = await startEngine({ print: () => undefined });
    engines.push(engine);
    await expect(wrapped.run()).resolves.toBe("bare");
  });

  it("still asks for the input a definition requires", () => {
    const greet = step("needs-input")
      .input(z.object({ name: z.string() }))
      .do(({ input }) => input.name);
    const review = step("needs-child")
      .input(z.object({ code: z.string() }))
      .do(({ input }) => input.code);
    const typeOnly = () => {
      // @ts-expect-error a definition with required input cannot lock with nothing
      greet();
      // @ts-expect-error nor via parallel()
      greet.parallel();
      // @ts-expect-error nor via series()
      greet.series();
      // @ts-expect-error nor can one whose input a child must supply
      review();
      // @ts-expect-error nor via parallel()
      review.parallel();
      // @ts-expect-error nor via series()
      review.series();
      // @ts-expect-error nor be run with nothing
      greet.run();
      // @ts-expect-error nor launched with nothing
      greet.launch();
    };
    expect(typeOnly).toBeTypeOf("function");
    expectTypeOf(greet({}, { name: "Ada" })).toEqualTypeOf<
      LockedNode<string>
    >();
  });
});
