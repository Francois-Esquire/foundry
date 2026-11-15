/**
 * Each load's copies of a workspace's modules (`workspace/copies.ts`): only
 * import specifiers are rewritten, and every import, computed ones
 * included, reaches the load's own copy. The loader is a Bun plugin, so
 * each scenario runs in its own `bun` process.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const SRC = resolve("src");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function scratch(): Promise<string> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "marbles-copies-")));
  roots.push(root);
  return root;
}

/** Runs `body` with the loader registered, from `root`; resolves its JSON report. */
async function withLoader(
  root: string,
  body: string
): Promise<Record<string, unknown>> {
  const script = join(root, "run.ts");
  await writeFile(
    script,
    `import { plugin } from "bun";
import { copyModules, importLoad } from ${JSON.stringify(join(SRC, "workspace/copies.ts"))};
plugin({ name: "copies-test", setup: copyModules, target: "bun" });
const report = {};
${body}
process.stdout.write(JSON.stringify(report) + "\\n");
`
  );
  const output = execFileSync("bun", ["--no-env-file", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
  });
  return JSON.parse(output.trim().split("\n").at(-1) ?? "{}");
}

it("rewrites import specifiers alone, and leaves a string that spells one as written", async () => {
  const root = await scratch();
  await writeFile(join(root, "helper.ts"), "export const x = 1;\n");
  await writeFile(join(root, "side.ts"), "globalThis.sideRan = true;\n");
  await writeFile(join(root, "types.ts"), "export type T = number;\n");
  await writeFile(join(root, "star.ts"), "export const star = 2;\n");
  await writeFile(join(root, "later.ts"), "export const later = 3;\n");
  await writeFile(
    join(root, "entry.ts"),
    `import { existsSync } from "node:fs";
import type { T } from './types';
import { x } from "./helper.ts";
import "./side";
export * from "./star.ts";
export { x as again } from './helper.ts';
const quoted = "./helper.ts";
const single = './side';
// import "./helper.ts" in a comment
const template = \`import "./helper.ts"\`;
const n: T = 1;
globalThis.report = {
  exists: existsSync("./helper.ts"),
  later: (await import("./later.ts")).later,
  n,
  quoted,
  single,
  template,
  url: import.meta.url,
  x,
};
`
  );
  const report = await withLoader(
    root,
    `await importLoad(${JSON.stringify(root)}, [${JSON.stringify(join(root, "entry.ts"))}]);
report.entry = globalThis.report;
report.side = globalThis.sideRan;
report.star = (await import(${JSON.stringify(join(root, "entry.ts"))} + "?marbles-load=1")).star;`
  );
  expect(report.entry).toMatchObject({
    exists: true,
    later: 3,
    n: 1,
    quoted: "./helper.ts",
    single: "./side",
    template: 'import "./helper.ts"',
    x: 1,
  });
  expect((report.entry as { url: string }).url).toContain(
    "entry.ts?marbles-load="
  );
  expect(report.side).toBe(true);
  expect(report.star).toBe(2);
});

it("gives an import computed at run time the load's own copy, from the importing file", async () => {
  const root = await scratch();
  const late = join(root, "late.ts");
  await writeFile(
    late,
    "globalThis.evaluations = (globalThis.evaluations ?? 0) + 1;\nexport const n = globalThis.evaluations;\n"
  );
  await writeFile(
    join(root, "entry.ts"),
    "const path = './late.ts';\nglobalThis.late = () => import(path);\nglobalThis.bare = () => import(['node', 'fs'].join(':'));\n"
  );
  const report = await withLoader(
    root,
    `const entry = ${JSON.stringify(join(root, "entry.ts"))};
await importLoad(${JSON.stringify(root)}, [entry]);
report.first = (await globalThis.late()).n;
report.again = (await globalThis.late()).n;
await Bun.write(${JSON.stringify(late)}, "export const n = 999;\\n");
await importLoad(${JSON.stringify(root)}, [entry]);
report.reloaded = (await globalThis.late()).n;
report.builtin = typeof (await globalThis.bare()).existsSync;`
  );
  expect(report).toEqual({
    again: 1,
    builtin: "function",
    first: 1,
    reloaded: 999,
  });
});

it("reads every data file a load reaches by path afresh for that load, by extension or `type`", async () => {
  const root = await scratch();
  const write = async (n: number) => {
    await writeFile(join(root, "data.json"), `{ "value": ${String(n)} }\n`);
    await writeFile(join(root, "notes.md"), `note ${String(n)}\n`);
    await writeFile(join(root, "conf.toml"), `value = ${String(n)}\n`);
    await writeFile(join(root, "conf.yaml"), `value: ${String(n)}\n`);
    await writeFile(join(root, "late.json"), `{ "value": ${String(n)} }\n`);
  };
  await write(1);
  await writeFile(
    join(root, "entry.ts"),
    `import data, { value } from "./data.json";
import notes from "./notes.md" with { type: "text" };
import conf from "./conf.toml";
import yaml from "./conf.yaml";
const path = "./late.json";
globalThis.seen = {
  conf: conf.value,
  data: data.value,
  late: (await import(path, { with: { type: "json" } })).default.value,
  named: value,
  notes: notes.trim(),
  yaml: yaml.value,
};
`
  );
  const report = await withLoader(
    root,
    `const entry = ${JSON.stringify(join(root, "entry.ts"))};
await importLoad(${JSON.stringify(root)}, [entry]);
report.first = globalThis.seen;
await Bun.write(${JSON.stringify(join(root, "data.json"))}, '{ "value": 2 }');
await Bun.write(${JSON.stringify(join(root, "notes.md"))}, "note 2");
await Bun.write(${JSON.stringify(join(root, "conf.toml"))}, "value = 2");
await Bun.write(${JSON.stringify(join(root, "conf.yaml"))}, "value: 2");
await Bun.write(${JSON.stringify(join(root, "late.json"))}, '{ "value": 2 }');
await importLoad(${JSON.stringify(root)}, [entry]);
report.second = globalThis.seen;`
  );
  const at = (n: number) => ({
    conf: n,
    data: n,
    late: n,
    named: n,
    notes: `note ${String(n)}`,
    yaml: n,
  });
  expect(report).toEqual({ first: at(1), second: at(2) });
});

it("fails the load of a file it cannot parse, naming the file, rather than load it unrewritten", async () => {
  const root = await scratch();
  const broken = join(root, "broken.ts");
  await writeFile(broken, "export foo from './foo';\n");
  const report = await withLoader(
    root,
    `report.error = await importLoad(${JSON.stringify(root)}, [${JSON.stringify(broken)}]).then(
  () => "loaded",
  (error) => error.message
);`
  );
  expect(report.error).toContain(`${broken} does not parse`);
});

it("reads an import's `type` from its syntax, past any comment before its options", async () => {
  const root = await scratch();
  const write = async (n: number) => {
    await writeFile(join(root, "notes.md"), `note ${String(n)}\n`);
    await writeFile(join(root, "static.md"), `static ${String(n)}\n`);
  };
  await write(1);
  await writeFile(
    join(root, "entry.ts"),
    `import notes from "./static.md" /* why */ with { type: "text" };
globalThis.seen = {
  dynamic: (await import("./notes.md" /* why */, { with: { type: "text" } })).default.trim(),
  static: notes.trim(),
};
`
  );
  const report = await withLoader(
    root,
    `const entry = ${JSON.stringify(join(root, "entry.ts"))};
await importLoad(${JSON.stringify(root)}, [entry]);
report.first = globalThis.seen;
await Bun.write(${JSON.stringify(join(root, "notes.md"))}, "note 2");
await Bun.write(${JSON.stringify(join(root, "static.md"))}, "static 2");
await importLoad(${JSON.stringify(root)}, [entry]);
report.second = globalThis.seen;`
  );
  expect(report).toEqual({
    first: { dynamic: "note 1", static: "static 1" },
    second: { dynamic: "note 2", static: "static 2" },
  });
});
