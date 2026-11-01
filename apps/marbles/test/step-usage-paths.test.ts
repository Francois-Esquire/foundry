import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { step, workflow } from "~/authoring/builder";
import { catalog } from "~/authoring/catalog";
import { agent } from "~/authoring/resources";
import type { Engine } from "~/lib/engine";
import type { StepSnapshot } from "~/model/dashboard";
import { dashboardSnapshot } from "~/workspace/snapshot";
import { startEngine } from "./helpers/engine";

const engines: Engine[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  catalog.reset();
});

function flatten(steps: readonly StepSnapshot[]): StepSnapshot[] {
  return steps.flatMap((item) => [item, ...flatten(item.children)]);
}

it("a step named `a.b` keeps its own turns: its sibling `a`, and `a`'s dynamic child, never take them", async () => {
  const reviewer = agent({ name: "reviewer", prompt: "Review." });
  const shared = step("shared").do(async ({ agents }) => {
    const session = await agents.session(reviewer);
    return (await session.generate("shared")).text;
  });
  const own = step("a").do(async ({ agents }) => {
    const session = await agents.session(reviewer);
    await session.generate("a");
    return await shared.run();
  });
  const dotted = step("a.b").do(async ({ agents }) => {
    const session = await agents.session(reviewer);
    return (await session.generate("dotted")).text;
  });
  const join = step()
    .input(z.object({ a: z.unknown(), "a.b": z.unknown() }))
    .do(() => "joined");
  workflow("flow").do(() => join({ a: own({}), "a.b": dotted({}) }));
  const engine = await startEngine({ print: () => undefined });
  engines.push(engine);
  const launched = await engine.launch("flow", {});
  await launched.result;
  const snapshot = dashboardSnapshot(await engine.runs(), {
    definitions: engine.definitions(),
    lastFinish: new Map(),
    monitors: engine.monitors(),
    root: process.cwd(),
    schedules: [],
    startedAt: 0,
    status: "Ready",
    usage: await engine.readUsage(),
    workspaceId: "test",
  });
  const run = snapshot.runs.find((item) => item.id === launched.id);
  const steps = flatten(run?.steps ?? []);
  const byId = (id: string) => steps.filter((item) => item.id === id);
  const [a] = byId("flow.a");
  const [ab] = byId("flow.a.b");
  // Joined as `flow.a.` the sibling looks like `a`'s child; it is not.
  expect(a?.usage?.direct.turns).toBe(1);
  expect(a?.usage?.inclusive.turns).toBe(2);
  expect(ab?.name).toBe("a.b");
  expect(ab?.usage?.direct.turns).toBe(1);
  expect(ab?.usage?.inclusive.turns).toBe(1);
  // The step definition `shared` ran as `a`'s dynamic child.
  const dynamic = a?.children.find((item) => item.usage);
  expect(dynamic?.usage?.direct.turns).toBe(1);
  // Each turn counts once in the run, the steps' totals never added up.
  expect(run?.usage?.turns).toBe(3);
});
