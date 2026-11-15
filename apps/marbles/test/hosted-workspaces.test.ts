/**
 * Several workspaces hosted in one process (`HostedWorkspaces`): each
 * loaded into a catalog, an engine and an execution context of its own,
 * over one handle on the Marbles database. Source loads through a Bun
 * plugin, so each scenario runs in its own `bun` process.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { recordedWorkspaces } from "~/database/workspaces";

const SRC = resolve("src");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function scratch(): Promise<string> {
  const root = realpathSync(
    await mkdtemp(join(tmpdir(), "marbles-hosted-workspaces-"))
  );
  roots.push(root);
  return root;
}

/**
 * A workspace named `name`: its `.env.schema` resolves `MARBLES_TEST_VALUE`
 * to its name (through a stand-in `varlock`), and its source declares the
 * same local names every other one does: a step `build`, its schedule, a
 * monitor, an agent `helper`, and an observer of `tasks`.
 */
async function workspace(
  root: string,
  name: string,
  tail = ""
): Promise<{ readonly dir: string; readonly source: string }> {
  const dir = join(root, name);
  const bin = join(dir, "node_modules", ".bin");
  await mkdir(bin, { recursive: true });
  await mkdir(join(dir, "sub"));
  await writeFile(join(dir, ".env.schema"), "MARBLES_TEST_VALUE=\n");
  const varlock = join(bin, "varlock");
  await writeFile(
    varlock,
    `#!/bin/sh\nprintf '{"MARBLES_TEST_VALUE":"${name}"}'\n`
  );
  chmodSync(varlock, 0o755);
  const source = join(dir, "marbles.ts");
  await writeFile(source, sourceText(name, tail));
  return { dir, source };
}

function sourceText(name: string, tail = ""): string {
  return `import { agent, monitor, observe, schedule, step, tasks } from "@foundry.sh/marbles";
export const helper = agent({ name: "helper", prompt: "Help ${name}." });
export const build = step("build").do(async ({ exec }) => {
  await tasks.create({ title: "built ${name}" });
  const { stdout } = await exec(["sh", "-c", 'pwd -P; printf %s "$MARBLES_TEST_VALUE"']);
  return stdout;
});
schedule(build).every("1d");
monitor("notes/*.md").do(() => undefined);
observe(tasks, async (payload) => {
  for (const change of payload.tasks) {
    if (change.after?.title === "ping") {
      await tasks.create({ title: "pong ${name}" });
    }
  }
});
${tail}`;
}

/** Runs `body` in a fresh `bun` process with `hosted` open; resolves its JSON report. */
async function inProcess(
  root: string,
  body: string
): Promise<Record<string, unknown>> {
  const script = join(root, `host-${String(Date.now())}.ts`);
  await writeFile(
    script,
    `import { HostedWorkspaces } from ${JSON.stringify(join(SRC, "workspace/hosted.ts"))};
import { hostTasks } from ${JSON.stringify(join(SRC, "workspace/open.ts"))};
const report = {};
const environment = { ...process.env };
const hosted = await HostedWorkspaces.open({
  artifacts: ${JSON.stringify(join(root, "artifacts"))},
  env: "require",
  state: ${JSON.stringify(join(root, "state"))},
});
const titles = async (id) =>
  (await hostTasks(hosted.get(id).engine).list()).items.map((task) => task.title).sort();
const until = async (check) => {
  for (let tries = 0; tries < 200 && !(await check()); tries += 1) {
    await new Promise((settle) => setTimeout(settle, 25));
  }
};
try {
${body}
} finally {
  await hosted.close();
}
report.environmentKept =
  JSON.stringify(environment) === JSON.stringify({ ...process.env });
process.stdout.write(JSON.stringify(report) + "\\n");
process.exit(0);
`
  );
  const { MARBLES_TEST_VALUE: _, ...env } = process.env;
  const output = execFileSync("bun", ["--no-env-file", script], {
    cwd: root,
    encoding: "utf8",
    env,
    timeout: 90_000,
  });
  return JSON.parse(output.trim().split("\n").at(-1) ?? "{}");
}

it("hosts two workspaces with the same local names in one process, each run in its own directory and environment", async () => {
  const root = await scratch();
  const a = await workspace(root, "alpha");
  const b = await workspace(root, "beta");
  const report = await inProcess(
    root,
    `const loads = await hosted.load([
    { config: ${JSON.stringify(a.source)}, cwd: ${JSON.stringify(join(a.dir, "sub"))}, root: ${JSON.stringify(a.dir)} },
    { config: ${JSON.stringify(b.source)}, root: ${JSON.stringify(b.dir)} },
  ]);
  report.loads = loads.map((load) => load.loaded);
  const [alpha, beta] = hosted.list().map((host) => host.id);
  report.ids = [alpha, beta];
  report.definitions = hosted.definitions();
  report.triggers = await hosted.triggers();
  report.agents = await Promise.all(
    hosted.list().map(async (host) => (await host.describe()).agents.map((agent) => agent.id))
  );
  report.alpha = await hosted.run({ name: "build", workspace: alpha });
  report.beta = await hosted.run({ name: "build", workspace: beta });
  await hostTasks(hosted.get(alpha).engine).create({ title: "ping" });
  await until(async () => (await titles(alpha)).includes("pong alpha"));
  // Delivery in beta has nothing of alpha's to hand out.
  await new Promise((settle) => setTimeout(settle, 300));
  report.alphaTasks = await titles(alpha);
  report.betaTasks = await titles(beta);`
  );
  const [alpha, beta] = report.ids as [string, string];
  expect(report.loads).toEqual([true, true]);
  // Beside what the engine defines for itself, such as agent dispatch.
  expect(
    (report.definitions as { name: string }[]).filter(
      ({ name }) => name === "build"
    )
  ).toEqual([
    { name: "build", workspace: alpha },
    { name: "build", workspace: beta },
  ]);
  const triggers = (id: string) =>
    (report.triggers as { name: string; workspace: string }[])
      .filter((trigger) => trigger.workspace === id)
      .map((trigger) => trigger.name)
      .sort();
  // The same schedule and monitor keys, once in each workspace.
  expect(triggers(alpha)).toHaveLength(2);
  expect(triggers(beta)).toEqual(triggers(alpha));
  expect(report.agents).toEqual([["helper"], ["helper"]]);
  // Each run starts where its registration says, with its own values.
  expect(report.alpha).toBe(`${join(a.dir, "sub")}\nalpha`);
  expect(report.beta).toBe(`${b.dir}\nbeta`);
  // Steps and observers write their own workspace's tasks.
  expect(report.alphaTasks).toEqual(["built alpha", "ping", "pong alpha"]);
  expect(report.betaTasks).toEqual(["built beta"]);
  // Nothing was written to the process's own environment.
  expect(report.environmentKept).toBe(true);
  // Each registration is recorded, with where its work starts.
  const records = await recordedWorkspaces(join(root, "state"));
  expect(
    Object.fromEntries(records.map((record) => [record.root, record.cwd]))
  ).toEqual({ [a.dir]: join(a.dir, "sub"), [b.dir]: b.dir });
}, 120_000);

it("reports a workspace that fails to load on its own, keeps nothing it declared, and loads it once fixed", async () => {
  const root = await scratch();
  const a = await workspace(root, "alpha");
  const broken = await workspace(
    root,
    "broken",
    'throw new Error("broken on purpose");\n'
  );
  const report = await inProcess(
    root,
    `const loads = await hosted.load([
    { config: ${JSON.stringify(broken.source)}, root: ${JSON.stringify(broken.dir)} },
    { config: ${JSON.stringify(a.source)}, root: ${JSON.stringify(a.dir)} },
  ]);
  report.loads = loads.map((load) =>
    load.loaded ? { loaded: true, root: load.root } : { error: load.error.message, loaded: false, root: load.root }
  );
  report.definitions = hosted.definitions().map(({ name, workspace }) => workspace + "/" + name);
  report.workspaces = hosted.list().map((host) => host.id);
  const [alpha] = hosted.list().map((host) => host.id);
  report.alpha = await hosted.run({ name: "build", workspace: alpha });
  await Bun.write(${JSON.stringify(broken.source)}, ${JSON.stringify(sourceText("broken"))});
  const fixed = await hosted.register({ config: ${JSON.stringify(broken.source)}, root: ${JSON.stringify(broken.dir)} });
  report.fixed = await hosted.run({ name: "build", workspace: fixed.id });`
  );
  const [failed, loaded] = report.loads as Record<string, unknown>[];
  expect(failed).toMatchObject({ loaded: false, root: broken.dir });
  expect(failed?.error).toContain(
    `the workspace at ${broken.dir} did not load`
  );
  expect(failed?.error).toContain("broken on purpose");
  expect(loaded).toEqual({ loaded: true, root: a.dir });
  // What the failed load declared before it threw is nowhere.
  const [alpha] = report.workspaces as [string];
  expect(report.workspaces).toHaveLength(1);
  expect(report.definitions).toContain(`${alpha}/build`);
  expect(report.alpha).toBe(`${a.dir}\nalpha`);
  expect(report.fixed).toBe(`${broken.dir}\nbroken`);
}, 120_000);

it("loads a workspace again in the same process with fresh copies of its own modules, helpers included", async () => {
  const root = await scratch();
  const a = await workspace(
    root,
    "alpha",
    // Extensionless, as authors write it: Bun resolves it with no hook.
    'import { helped } from "./_helper";\nexport { helped };\n'
  );
  await writeFile(
    join(a.dir, "_helper.ts"),
    `import { step } from "@foundry.sh/marbles";
globalThis.helperEvaluations = (globalThis.helperEvaluations ?? 0) + 1;
export const helped = step("helped").do(() => "helped");
`
  );
  const report = await inProcess(
    root,
    `const registration = { config: ${JSON.stringify(a.source)}, root: ${JSON.stringify(a.dir)} };
  const first = await hosted.register(registration);
  report.first = await hosted.run({ name: "helped", workspace: first.id });
  await first.close();
  const again = await HostedWorkspaces.open({
    artifacts: ${JSON.stringify(join(root, "artifacts"))},
    state: ${JSON.stringify(join(root, "state"))},
  });
  try {
    const second = await again.register(registration);
    report.second = await again.run({ name: "helped", workspace: second.id });
  } finally {
    await again.close();
  }
  report.evaluations = globalThis.helperEvaluations;`
  );
  expect(report.first).toBe("helped");
  expect(report.second).toBe("helped");
  expect(report.evaluations).toBe(2);
}, 120_000);
