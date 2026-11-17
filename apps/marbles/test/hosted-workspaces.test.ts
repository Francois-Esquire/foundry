import { execFileSync } from "node:child_process";
import { chmodSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { recordedWorkspaces } from "~/database/workspaces";

const SRC = resolve("src");
const AMBIGUOUS = /names no workspace/;
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

const FAILING_DATABASE_CLOSE = `import { mock } from "bun:test";
const workspacesModule = ${JSON.stringify(join(SRC, "database/workspaces.ts"))};
const realWorkspaces = { ...(await import(workspacesModule)) };
mock.module(workspacesModule, () => ({
  ...realWorkspaces,
  openHostDatabase: async (...args) => {
    const opened = await realWorkspaces.openHostDatabase(...args);
    return new Proxy(opened, {
      get(target, property) {
        if (property === "close") {
          return () => {
            target.close();
            throw new Error("the database failed to close");
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  },
}));
`;

async function inProcess(
  root: string,
  body: string,
  prelude = ""
): Promise<Record<string, unknown>> {
  const script = join(root, `host-${String(Date.now())}.ts`);
  await writeFile(
    script,
    `${prelude}const { HostedWorkspaces } = await import(${JSON.stringify(join(SRC, "workspace/hosted.ts"))});
const { hostTasks } = await import(${JSON.stringify(join(SRC, "workspace/open.ts"))});
const { tasks } = await import(${JSON.stringify(join(SRC, "authoring/tasks.ts"))});
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
  // Closing again shares the first close, and its failure, which a body
  // that closes reports itself.
  await hosted.close().catch((error) => {
    report.closeFailed = (error.errors ?? [error]).map((each) => each.message);
  });
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
  expect(triggers(alpha)).toHaveLength(2);
  expect(triggers(beta)).toEqual(triggers(alpha));
  expect(report.agents).toEqual([["helper"], ["helper"]]);
  expect(report.alpha).toBe(`${join(a.dir, "sub")}\nalpha`);
  expect(report.beta).toBe(`${b.dir}\nbeta`);
  expect(report.alphaTasks).toEqual(["built alpha", "ping", "pong alpha"]);
  expect(report.betaTasks).toEqual(["built beta"]);
  expect(report.environmentKept).toBe(true);
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

it("names what a load declares from its consts, as written, the same on every load", async () => {
  const root = await scratch();
  const a = await workspace(
    root,
    "alpha",
    `export const nightly = step().do(() => "nightly");
export const reviewer = agent({ prompt: "Review alpha." });
`
  );
  await writeFile(
    join(a.dir, "twice.ts"),
    'import { step } from "@foundry.sh/marbles";\nexport const twice = step("build").do(() => "again");\n'
  );
  await symlink(
    resolve("../../node_modules/typescript"),
    join(a.dir, "node_modules", "typescript")
  );
  const report = await inProcess(
    root,
    `const registration = { config: ${JSON.stringify(a.source)}, root: ${JSON.stringify(a.dir)} };
  const [load] = await hosted.load([{ config: ${JSON.stringify(a.dir)}, root: ${JSON.stringify(a.dir)} }]);
  report.twice = load.loaded ? "loaded" : load.error.message;
  const first = await hosted.register(registration);
  const names = async (host) => ({
    agents: (await host.describe()).agents.map((agent) => agent.id).sort(),
    definitions: host.engine.definitions().map(({ name }) => name).sort(),
  });
  report.first = await names(first);
  await first.close();
  const again = await HostedWorkspaces.open({
    artifacts: ${JSON.stringify(join(root, "artifacts"))},
    state: ${JSON.stringify(join(root, "state"))},
  });
  try {
    report.second = await names(await again.register(registration));
  } finally {
    await again.close();
  }`
  );
  expect(report.twice).toContain(`${a.dir}/marbles.ts:`);
  expect(report.twice).toContain(`${a.dir}/twice.ts:`);
  expect(report.twice).not.toContain("marbles-load");
  expect(report.first).toEqual({
    agents: ["helper", "reviewer"],
    definitions: expect.arrayContaining(["build", "nightly"]),
  });
  expect(report.second).toEqual(report.first);
}, 120_000);

it("keeps where a workspace was registered to work when a later host names nowhere, and refuses tasks no workspace's work asks for", async () => {
  const root = await scratch();
  const a = await workspace(root, "alpha");
  const b = await workspace(root, "beta");
  const report = await inProcess(
    root,
    `const sub = ${JSON.stringify(join(a.dir, "sub"))};
  const first = await hosted.register({ config: ${JSON.stringify(a.source)}, cwd: sub, root: ${JSON.stringify(a.dir)} });
  await first.close();
  const again = await HostedWorkspaces.open({
    artifacts: ${JSON.stringify(join(root, "artifacts"))},
    state: ${JSON.stringify(join(root, "state"))},
  });
  try {
    const alpha = await again.register({ config: ${JSON.stringify(a.source)}, root: ${JSON.stringify(a.dir)} });
    report.alpha = await again.run({ name: "build", workspace: alpha.id });
    await again.register({ config: ${JSON.stringify(b.source)}, root: ${JSON.stringify(b.dir)} });
    report.outside = await tasks.list().then(() => "answered", (error) => error.message);
  } finally {
    await again.close();
  }`
  );
  expect(report.alpha).toBe(`${join(a.dir, "sub")}\nalpha`);
  expect(report.outside).toMatch(AMBIGUOUS);
  const records = await recordedWorkspaces(join(root, "state"));
  expect(records.find((record) => record.root === a.dir)?.cwd).toBe(
    join(a.dir, "sub")
  );
}, 120_000);

it("keeps what a workspace's module declares late, from a callback, in that workspace, while another loads", async () => {
  const root = await scratch();
  const a = await workspace(
    root,
    "alpha",
    `globalThis.alphaLate = new Promise((fire) => { globalThis.fireAlphaLate = fire; }).then(() => {
  step("late-from-alpha").do(() => "late");
});
`
  );
  const b = await workspace(
    root,
    "beta",
    "globalThis.fireAlphaLate();\nawait globalThis.alphaLate;\n"
  );
  const report = await inProcess(
    root,
    `const { openWorkspace } = await import(${JSON.stringify(join(SRC, "workspace/open.ts"))});
  const open = (dir, source) => openWorkspace(
    { artifacts: ${JSON.stringify(join(root, "artifacts"))}, config: source, directory: dir, dry: true, state: ${JSON.stringify(join(root, "state"))} },
    { print: () => undefined }
  );
  const alpha = await open(${JSON.stringify(a.dir)}, ${JSON.stringify(a.source)});
  const beta = await open(${JSON.stringify(b.dir)}, ${JSON.stringify(b.source)});
  report.alpha = [...alpha.catalog.definitions.keys()].sort();
  report.beta = [...beta.catalog.definitions.keys()].sort();`
  );
  expect(report.alpha).toEqual(["build", "late-from-alpha"]);
  expect(report.beta).toEqual(["build"]);
}, 120_000);

it("refuses what a closed workspace's work does later, rather than give it to the workspace left", async () => {
  const root = await scratch();
  const a = await workspace(
    root,
    "alpha",
    `export const arm = step("arm").do(() => {
  globalThis.alphaLate = new Promise((release) => { globalThis.releaseAlpha = release; })
    .then(() => tasks.create({ title: "late alpha" }));
  globalThis.alphaCallback = () => tasks.create({ title: "callback alpha" });
  return "armed";
});
// Both in tail position: nothing of alpha's is left on the stack when they run.
globalThis.alphaRun = () => build.run();
`
  );
  const b = await workspace(root, "beta");
  const report = await inProcess(
    root,
    `const alpha = await hosted.register({ config: ${JSON.stringify(a.source)}, root: ${JSON.stringify(a.dir)} });
  const beta = await hosted.register({ config: ${JSON.stringify(b.source)}, root: ${JSON.stringify(b.dir)} });
  await hosted.run({ name: "arm", workspace: alpha.id });
  // Called from outside any run: alpha's own code still names alpha.
  await globalThis.alphaCallback();
  report.alphaRun = await globalThis.alphaRun();
  report.alphaTasks = await titles(alpha.id);
  await alpha.close();
  report.runAfterClose = await globalThis.alphaRun().then(() => "ran", (error) => error.message);
  globalThis.releaseAlpha();
  report.late = await globalThis.alphaLate.then(() => "written", (error) => error.message);
  report.betaTasks = await titles(beta.id);`
  );
  expect(report.alphaRun).toBe(`${a.dir}\nalpha`);
  expect(report.alphaTasks).toEqual(["built alpha", "callback alpha"]);
  expect(report.runAfterClose).toContain("is no longer hosted in this process");
  expect(report.late).toContain("is no longer hosted in this process");
  expect(report.betaTasks).toEqual([]);
}, 120_000);

it("shares one registration of a workspace between callers who register it at once", async () => {
  const root = await scratch();
  const a = await workspace(root, "alpha");
  const report = await inProcess(
    root,
    `const registration = { config: ${JSON.stringify(a.source)}, root: ${JSON.stringify(a.dir)} };
  const hosts = await Promise.all([hosted.register(registration), hosted.register(registration)]);
  report.same = hosts[0] === hosts[1];
  report.listed = hosted.list().length;
  await hosted.close();
  report.disposed = hosts.map((host) => host.engine.disposed);`
  );
  expect(report).toMatchObject({
    disposed: [true, true],
    listed: 1,
    same: true,
  });
}, 120_000);

it("loads every registered workspace again, reports each that fails, and fires a schedule by workspace and key", async () => {
  const root = await scratch();
  const a = await workspace(root, "alpha");
  const b = await workspace(root, "beta");
  const report = await inProcess(
    root,
    `const alpha = await hosted.register({ config: ${JSON.stringify(a.source)}, root: ${JSON.stringify(a.dir)} });
  await hosted.register({ config: ${JSON.stringify(b.source)}, root: ${JSON.stringify(b.dir)} });
  report.rolled = (await hosted.roll({ name: "build", workspace: alpha.id })).value;
  await hosted.close();
  await Bun.write(${JSON.stringify(b.source)}, 'throw new Error("beta is broken");');
  const again = await HostedWorkspaces.open({
    artifacts: ${JSON.stringify(join(root, "artifacts"))},
    state: ${JSON.stringify(join(root, "state"))},
  });
  try {
    report.loads = (await again.loadRegistered()).map((load) =>
      load.loaded ? { loaded: true, root: load.root } : { error: load.error.message, loaded: false, root: load.root }
    );
  } finally {
    await again.close();
  }`
  );
  expect(report.rolled).toBe(`${a.dir}\nalpha`);
  const loads = report.loads as Record<string, unknown>[];
  expect(loads).toHaveLength(2);
  expect(loads).toContainEqual({ loaded: true, root: a.dir });
  const failed = loads.find((load) => load.root === b.dir);
  expect(failed).toMatchObject({ loaded: false });
  expect(failed?.error).toContain("beta is broken");
  const records = await recordedWorkspaces(join(root, "state"));
  expect(records.map((record) => record.hosted)).toEqual([true, true]);
}, 120_000);

it("loads a module two workspaces import from outside their roots once for each of them", async () => {
  const root = await scratch();
  const shared = join(root, "shared.ts");
  await writeFile(
    shared,
    'import { step } from "@foundry.sh/marbles";\nexport const sharedStep = step("shared").do(() => "shared");\n'
  );
  const tail = `import ${JSON.stringify(shared)};\n`;
  const a = await workspace(root, "alpha", tail);
  const b = await workspace(root, "beta", tail);
  const report = await inProcess(
    root,
    `const loads = await hosted.load([
    { config: ${JSON.stringify(a.source)}, root: ${JSON.stringify(a.dir)} },
    { config: ${JSON.stringify(b.source)}, root: ${JSON.stringify(b.dir)} },
  ]);
  report.loads = loads.map((load) => load.loaded);
  report.shared = await Promise.all(
    hosted.list().map((host) => hosted.run({ name: "shared", workspace: host.id }))
  );`
  );
  expect(report.loads).toEqual([true, true]);
  expect(report.shared).toEqual(["shared", "shared"]);
}, 120_000);

it("refuses what a package declares while a workspace loads, since every workspace shares it", async () => {
  const root = await scratch();
  const a = await workspace(root, "alpha", 'import "declaring-package";\n');
  const pkg = join(a.dir, "node_modules", "declaring-package");
  await mkdir(pkg, { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    '{ "name": "declaring-package", "type": "module", "main": "index.js" }\n'
  );
  await writeFile(
    join(pkg, "index.js"),
    'import { step } from "@foundry.sh/marbles";\nstep("from-package").do(() => 1);\n'
  );
  const report = await inProcess(
    root,
    `const [load] = await hosted.load([{ config: ${JSON.stringify(a.source)}, root: ${JSON.stringify(a.dir)} }]);
  report.load = load.loaded ? "loaded" : load.error.message;`
  );
  expect(report.load).toContain("comes from a package");
}, 120_000);

it("fails a registered workspace whose source is gone, loads one registered without a source, and forgets an unregistered one", async () => {
  const root = await scratch();
  const a = await workspace(root, "alpha");
  const bare = join(root, "bare");
  await mkdir(bare);
  const report = await inProcess(
    root,
    `const alpha = await hosted.register({ config: ${JSON.stringify(a.source)}, root: ${JSON.stringify(a.dir)} });
  await hosted.register({ config: null, root: ${JSON.stringify(bare)} });
  await hosted.close();
  const { rmSync } = await import("node:fs");
  rmSync(${JSON.stringify(a.source)});
  const open = () => HostedWorkspaces.open({
    artifacts: ${JSON.stringify(join(root, "artifacts"))},
    state: ${JSON.stringify(join(root, "state"))},
  });
  const again = await open();
  try {
    report.loads = (await again.loadRegistered()).map((load) =>
      load.loaded ? { loaded: true, root: load.root } : { error: load.error.message, loaded: false, root: load.root }
    );
    report.unregistered = await again.unregister(alpha.id);
  } finally {
    await again.close();
  }
  const last = await open();
  try {
    report.after = (await last.loadRegistered()).map((load) => load.root);
  } finally {
    await last.close();
  }`
  );
  const loads = report.loads as Record<string, unknown>[];
  expect(loads).toContainEqual({ loaded: true, root: realpathSync(bare) });
  const gone = loads.find((load) => load.root === a.dir);
  expect(gone).toMatchObject({ loaded: false });
  expect(gone?.error).toContain(`its registered source ${a.source} is gone`);
  expect(report.unregistered).toBe(true);
  expect(report.after).toEqual([realpathSync(bare)]);
}, 120_000);

it("declares what a package's function makes with the words a workspace's source hands it", async () => {
  const root = await scratch();
  const a = await workspace(
    root,
    "alpha",
    'import { make } from "word-taking-package";\nexport const made = make({ step });\n'
  );
  const pkg = join(a.dir, "node_modules", "word-taking-package");
  await mkdir(pkg, { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    '{ "name": "word-taking-package", "type": "module", "main": "index.js" }\n'
  );
  await writeFile(
    join(pkg, "index.js"),
    'export const make = ({ step }) => step("made-by-package").do(() => "made");\n'
  );
  const report = await inProcess(
    root,
    `const alpha = await hosted.register({ config: ${JSON.stringify(a.source)}, root: ${JSON.stringify(a.dir)} });
  report.helper = await hosted.run({ name: "made-by-package", workspace: alpha.id });`
  );
  expect(report.helper).toBe("made");
}, 120_000);

it("lets every workspace finish closing before it closes the database, and reports each that failed", async () => {
  const root = await scratch();
  const a = await workspace(root, "alpha");
  const b = await workspace(root, "beta");
  const report = await inProcess(
    root,
    `const alpha = await hosted.register({ config: ${JSON.stringify(a.source)}, root: ${JSON.stringify(a.dir)} });
  const beta = await hosted.register({ config: ${JSON.stringify(b.source)}, root: ${JSON.stringify(b.dir)} });
  const closeAlpha = alpha.close.bind(alpha);
  alpha.close = async () => {
    await closeAlpha();
    throw new Error("alpha failed to close");
  };
  const closeBeta = beta.close.bind(beta);
  beta.close = async () => {
    // Still saving through the shared handle after alpha has failed.
    await new Promise((settle) => setTimeout(settle, 200));
    try {
      await hostTasks(beta.engine).create({ title: "last write" });
      report.lastWrite = "kept";
    } catch (error) {
      report.lastWrite = String(error);
    }
    await closeBeta();
  };
  try {
    await hosted.close();
  } catch (error) {
    report.errors = (error.errors ?? [error]).map((each) => each.message);
  }`
  );
  expect(report.lastWrite).toBe("kept");
  expect(report.errors).toEqual(["alpha failed to close"]);
}, 120_000);

it("refuses what a closed workspace's module declares later, rather than keep it in a catalog no engine uses", async () => {
  const root = await scratch();
  const a = await workspace(
    root,
    "alpha",
    'globalThis.declareLate = () => step("late").do(() => "late");\n'
  );
  const report = await inProcess(
    root,
    `const alpha = await hosted.register({ config: ${JSON.stringify(a.source)}, root: ${JSON.stringify(a.dir)} });
  await alpha.close();
  try {
    globalThis.declareLate();
    report.late = "declared";
  } catch (error) {
    report.late = error.name;
  }`
  );
  expect(report.late).toBe("WorkspaceReleasedError");
}, 120_000);

it("refuses a first load's late work once its workspace is hosted again, and the new host answers its own", async () => {
  const root = await scratch();
  const a = await workspace(
    root,
    "alpha",
    `globalThis.loads = [...(globalThis.loads ?? []), {
  declare: () => step("late").do(() => "late"),
  run: () => build.run(),
}];
`
  );
  const report = await inProcess(
    root,
    `const registration = { config: ${JSON.stringify(a.source)}, root: ${JSON.stringify(a.dir)} };
  const alpha = await hosted.register(registration);
  await hosted.unregister(alpha.id);
  const again = await hosted.register(registration);
  report.hostedAgain = again !== alpha && !again.engine.disposed;
  const [first] = globalThis.loads;
  try {
    first.declare();
    report.late = "declared";
  } catch (error) {
    report.late = error.name;
  }
  report.lateRun = await first.run().then(() => "ran", (error) => error.name);
  report.inNew = again.engine.definitions().some(({ name }) => name === "late");
  report.newRun = await hosted.run({ name: "build", workspace: again.id });`
  );
  expect(report).toMatchObject({
    hostedAgain: true,
    inNew: false,
    late: "WorkspaceReleasedError",
    lateRun: "WorkspaceReleasedError",
  });
  expect(report.newRun).toBe(`${a.dir}\nalpha`);
}, 120_000);

function heldClose(name: string): string {
  return `let release${name};
  const held${name} = new Promise((settle) => { release${name} = settle; });
  const close${name} = ${name}.close.bind(${name});
  ${name}.close = async () => {
    await held${name};
    report.lastWrite${name} = await hostTasks(${name}.engine).create({ title: "last write" }).then(() => "kept", (error) => String(error));
    await close${name}();
  };`;
}

it("closes the database once, after every host closing, when it is closed twice at once", async () => {
  const root = await scratch();
  const a = await workspace(root, "alpha");
  const report = await inProcess(
    root,
    `const alpha = await hosted.register({ config: ${JSON.stringify(a.source)}, root: ${JSON.stringify(a.dir)} });
  ${heldClose("alpha")}
  let done = 0;
  const first = hosted.close().then(() => { done += 1; });
  await new Promise((settle) => setTimeout(settle, 50));
  const second = hosted.close().then(() => { done += 1; });
  await new Promise((settle) => setTimeout(settle, 100));
  report.doneWhileHostClosing = done;
  releasealpha();
  await Promise.all([first, second]);
  report.disposed = alpha.engine.disposed;`
  );
  expect(report).toMatchObject({
    disposed: true,
    doneWhileHostClosing: 0,
    lastWritealpha: "kept",
  });
}, 120_000);

it("waits for a host an unregister is closing before it closes the database", async () => {
  const root = await scratch();
  const a = await workspace(root, "alpha");
  const report = await inProcess(
    root,
    `const alpha = await hosted.register({ config: ${JSON.stringify(a.source)}, root: ${JSON.stringify(a.dir)} });
  ${heldClose("alpha")}
  const unregistering = hosted.unregister(alpha.id);
  await new Promise((settle) => setTimeout(settle, 50));
  let closed = false;
  const closing = hosted.close().then(() => { closed = true; });
  await new Promise((settle) => setTimeout(settle, 100));
  report.closedWhileUnregistering = closed;
  releasealpha();
  report.unregistered = await unregistering.then(String, (error) => String(error));
  await closing;
  report.disposed = alpha.engine.disposed;`
  );
  expect(report).toMatchObject({
    closedWhileUnregistering: false,
    disposed: true,
    lastWritealpha: "kept",
    unregistered: "true",
  });
}, 120_000);

it("keeps a workspace registered when it is registered again while an unregister is closing its host", async () => {
  const root = await scratch();
  const a = await workspace(root, "alpha");
  const report = await inProcess(
    root,
    `const registration = { config: ${JSON.stringify(a.source)}, root: ${JSON.stringify(a.dir)} };
  const alpha = await hosted.register(registration);
  ${heldClose("alpha")}
  const unregistering = hosted.unregister(alpha.id);
  await new Promise((settle) => setTimeout(settle, 50));
  const registering = hosted.register(registration);
  await new Promise((settle) => setTimeout(settle, 100));
  releasealpha();
  report.unregistered = await unregistering;
  const again = await registering;
  report.hostedAgain = again !== alpha && !again.engine.disposed;
  await hosted.close();
  const next = await HostedWorkspaces.open({
    artifacts: ${JSON.stringify(join(root, "artifacts"))},
    state: ${JSON.stringify(join(root, "state"))},
  });
  try {
    report.registered = (await next.loadRegistered()).map((load) => load.root);
  } finally {
    await next.close();
  }`
  );
  expect(report).toMatchObject({
    hostedAgain: true,
    registered: [a.dir],
    unregistered: true,
  });
}, 120_000);

it("keeps a workspace registered again after a second unregister, while the first is still closing its host", async () => {
  const root = await scratch();
  const a = await workspace(root, "alpha");
  const report = await inProcess(
    root,
    `const registration = { config: ${JSON.stringify(a.source)}, root: ${JSON.stringify(a.dir)} };
  const alpha = await hosted.register(registration);
  ${heldClose("alpha")}
  const first = hosted.unregister(alpha.id);
  await new Promise((settle) => setTimeout(settle, 50));
  const second = hosted.unregister(alpha.id);
  await new Promise((settle) => setTimeout(settle, 50));
  const registering = hosted.register(registration);
  await new Promise((settle) => setTimeout(settle, 100));
  releasealpha();
  report.unregistered = [await first, await second];
  const again = await registering;
  report.hostedAgain = again !== alpha && !again.engine.disposed;
  await hosted.close();
  const next = await HostedWorkspaces.open({
    artifacts: ${JSON.stringify(join(root, "artifacts"))},
    state: ${JSON.stringify(join(root, "state"))},
  });
  try {
    report.registered = (await next.loadRegistered()).map((load) => load.root);
  } finally {
    await next.close();
  }`
  );
  expect(report).toMatchObject({
    hostedAgain: true,
    registered: [a.dir],
    unregistered: [true, true],
  });
}, 120_000);

it("reports every host's failure and the database's own when both fail to close", async () => {
  const root = await scratch();
  const a = await workspace(root, "alpha");
  const report = await inProcess(
    root,
    `const alpha = await hosted.register({ config: ${JSON.stringify(a.source)}, root: ${JSON.stringify(a.dir)} });
  const closeAlpha = alpha.close.bind(alpha);
  alpha.close = async () => {
    await closeAlpha();
    throw new Error("alpha failed to close");
  };
  try {
    await hosted.close();
  } catch (error) {
    report.errors = (error.errors ?? [error]).map((each) => each.message);
  }`,
    FAILING_DATABASE_CLOSE
  );
  expect(report.errors).toEqual([
    "alpha failed to close",
    "the database failed to close",
  ]);
}, 120_000);

it("lets a reading of the registered workspaces finish before the database closes, and refuses one after", async () => {
  const root = await scratch();
  const a = await workspace(root, "alpha");
  const report = await inProcess(
    root,
    `await hosted.register({ config: ${JSON.stringify(a.source)}, root: ${JSON.stringify(a.dir)} });
  const loading = hosted.loadRegistered();
  const closing = hosted.close();
  report.loads = await loading.then((loads) => loads.map((load) => load.loaded), (error) => String(error));
  await closing;
  report.after = await hosted.loadRegistered().then(() => "loaded", (error) => error.message);
  report.unregisterAfter = await hosted.unregister("any").then(() => "unregistered", (error) => error.message);`
  );
  expect(report.loads).toEqual([false]);
  expect(report.after).toBe("these hosted workspaces are closed");
  expect(report.unregisterAfter).toBe("these hosted workspaces are closed");
}, 120_000);

it("lets go of a host closed directly, hosts its workspace again on the next register, and waits for that close before closing the database", async () => {
  const root = await scratch();
  const a = await workspace(root, "alpha");
  const report = await inProcess(
    root,
    `const registration = { config: ${JSON.stringify(a.source)}, root: ${JSON.stringify(a.dir)} };
  const alpha = await hosted.register(registration);
  await alpha.close();
  report.listed = hosted.list().length;
  report.get = (() => { try { hosted.get(alpha.id); return "returned"; } catch (error) { return error.message; } })();
  const again = await hosted.register(registration);
  report.fresh = again !== alpha && !again.engine.disposed;
  // Its close is held inside, where stopping runs and saving sessions take time.
  let release;
  const held = new Promise((settle) => { release = settle; });
  const dispose = again.engine.dispose.bind(again.engine);
  again.engine.dispose = async () => {
    await held;
    report.lastWrite = await hostTasks(again.engine).create({ title: "last write" }).then(() => "kept", (error) => String(error));
    return await dispose();
  };
  const direct = again.close();
  report.sameClose = again.close() === direct;
  report.listedWhileClosing = hosted.list().length;
  let closed = false;
  const closing = hosted.close().then(() => { closed = true; });
  await new Promise((settle) => setTimeout(settle, 100));
  report.closedWhileHostClosing = closed;
  release();
  await direct;
  await closing;`
  );
  expect(report).toMatchObject({
    closedWhileHostClosing: false,
    fresh: true,
    get: expect.stringContaining("is hosted here"),
    lastWrite: "kept",
    listed: 0,
    listedWhileClosing: 0,
    sameClose: true,
  });
}, 120_000);

it("hosts a workspace again while its last host is still closing, its new engine delivering once the old one has let go", async () => {
  const root = await scratch();
  const a = await workspace(root, "alpha");
  const report = await inProcess(
    root,
    `const registration = { config: ${JSON.stringify(a.source)}, root: ${JSON.stringify(a.dir)} };
  const alpha = await hosted.register(registration);
  let release;
  const held = new Promise((settle) => { release = settle; });
  const dispose = alpha.engine.dispose.bind(alpha.engine);
  alpha.engine.dispose = async () => {
    await held;
    return await dispose();
  };
  const closing = alpha.close();
  const again = await hosted.register(registration);
  report.fresh = again !== alpha && !again.engine.disposed;
  setTimeout(() => release(), 200);
  await hostTasks(again.engine).create({ title: "ping" });
  await until(async () => (await titles(again.id)).includes("pong alpha"));
  report.tasks = await titles(again.id);
  await closing;`
  );
  expect(report.fresh).toBe(true);
  expect(report.tasks).toEqual(["ping", "pong alpha"]);
}, 120_000);
