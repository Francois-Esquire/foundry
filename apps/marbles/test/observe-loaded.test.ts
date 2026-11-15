/**
 * `observe` as a workspace's own module declares it, through the library
 * its load is bound to: each word is the source of its objects' facts, an
 * observer is named by its handler, and a fact made inside a run records
 * that run. Each scenario runs in its own `bun` process, as
 * `host-tasks.test.ts` explains.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { asc } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { readDatabase } from "~/database/open";
import { marblesChanges, marblesObservers } from "~/database/tables";
import { stateDatabase } from "~/layout";

const SRC = resolve("src");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

it("delivers a loaded module's observers of every word the facts of a step's work, each with the run that made it, and names one by its const", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-observe-loaded-"));
  roots.push(root);
  const dir = join(root, "ws");
  await mkdir(join(dir, "node_modules"), { recursive: true });
  // A const names an observer through the author's own TypeScript, found
  // from the module.
  await symlink(
    resolve("../../node_modules/typescript"),
    join(dir, "node_modules", "typescript")
  );
  const seen = join(dir, "seen.log");
  const source = join(dir, "marbles.ts");
  await writeFile(
    source,
    `import { appendFileSync } from "node:fs";
import { agent, artifact, observe, sandbox, step, tasks, workflow, workspace } from "@foundry.sh/marbles";
const log = (line) => {
  appendFileSync(${JSON.stringify(seen)}, line + "\\n");
  // The host's barrier: told of each fact handed, once it is written down.
  globalThis.observed?.();
};
observe(workflow, function runFacts(fact) {
  log("runs " + fact.type);
}, { types: ["run.completed"] });
observe(artifact, function artifactFacts(fact) {
  log("artifacts " + fact.type);
}, { types: ["artifact.created"] });
// Named by the const it is assigned to.
export const taskFacts = observe(tasks, (fact) => {
  log("tasks " + fact.type);
});
observe(sandbox, () => undefined, { name: "sandboxFacts" });
observe(workspace, () => undefined, { name: "workspaceFacts" });
observe(agent, () => undefined, { name: "sessionFacts" });
const notes = artifact({ name: "notes", type: "text/markdown" });
export const write = step("write").do(async ({ run }) => {
  await tasks.create({ title: "from a step" });
  await notes.write({ "a.md": "# A" });
  return run.id;
});
`
  );
  const state = join(root, "state");
  const script = join(root, "host.ts");
  await writeFile(
    script,
    `import { hostEngine, openWorkspace } from ${JSON.stringify(join(SRC, "workspace/open.ts"))};
import { openHostDatabase } from ${JSON.stringify(join(SRC, "database/workspaces.ts"))};
// Settled once the three observers have each been handed their fact.
const { promise: allObserved, resolve: observedAll } = Promise.withResolvers();
let observed = 0;
globalThis.observed = () => {
  observed += 1;
  if (observed === 3) observedAll();
};
const args = { artifacts: ${JSON.stringify(join(root, "artifacts"))}, config: ${JSON.stringify(source)}, dry: false, state: ${JSON.stringify(state)} };
const opened = await openWorkspace(args, { print: () => undefined });
const database = await openHostDatabase(${JSON.stringify(state)});
const engine = await hostEngine(args, opened, { database, print: () => undefined });
await engine.start();
const runId = await engine.execute(opened.catalog.definitions.get("write"), {});
await allObserved;
await engine.dispose();
process.stdout.write(JSON.stringify({ runId }) + "\\n");
process.exit(0);
`
  );
  const output = execFileSync("bun", [script], {
    cwd: resolve("."),
    encoding: "utf8",
    timeout: 60_000,
  });
  const { runId } = JSON.parse(output.trim().split("\n").at(-1) ?? "{}");

  expect(readFileSync(seen, "utf8").trim().split("\n").sort()).toEqual([
    "artifacts artifact.created",
    "runs run.completed",
    "tasks tasks.changed",
  ]);
  const stored = await readDatabase(stateDatabase(state), async (database) => ({
    changes: await database
      .select({
        runId: marblesChanges.runId,
        source: marblesChanges.source,
        type: marblesChanges.type,
      })
      .from(marblesChanges)
      .orderBy(asc(marblesChanges.position)),
    observers: await database
      .select({
        name: marblesObservers.name,
        source: marblesObservers.source,
      })
      .from(marblesObservers)
      .orderBy(asc(marblesObservers.name)),
  }));
  // Every word a load's library binds is still its source.
  expect(stored?.observers).toEqual([
    { name: "artifactFacts", source: "artifacts" },
    { name: "runFacts", source: "runs" },
    { name: "sandboxFacts", source: "sandboxes" },
    { name: "sessionFacts", source: "sessions" },
    { name: "taskFacts", source: "tasks" },
    { name: "workspaceFacts", source: "workspaces" },
  ]);
  // The step's own work records its run as the cause.
  const made = (from: string, type: string) =>
    stored?.changes.find(
      (change) => change.source === from && change.type === type
    );
  expect(made("tasks", "tasks.changed")?.runId).toBe(runId);
  expect(made("artifacts", "artifact.created")?.runId).toBe(runId);
}, 120_000);
