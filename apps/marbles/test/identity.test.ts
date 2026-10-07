/**
 * Name inference reads the config's source at the call's position. Bun
 * loads TypeScript without a transpile step, so positions are the file's;
 * vitest runs under Node through vite's transforms, where they are not.
 * Hence `bun test`.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { catalog } from "~/authoring/catalog";
import { resetIdentity } from "~/authoring/identity";

const LIB = pathToFileURL(
  resolve(import.meta.dir, "../src/authoring/index.ts")
).href;
const NODE_MODULES = resolve(import.meta.dir, "../../../node_modules");
const AGENT_DIGEST = /^agent-[0-9a-f]{16}$/;

const dirs: string[] = [];

afterEach(() => {
  catalog.reset();
  resetIdentity();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

/** A config directory; with `typescript` reachable unless `bare`. */
function configDir(bare = false): string {
  const dir = mkdtempSync(join(tmpdir(), "marbles-identity-"));
  dirs.push(dir);
  if (!bare) {
    symlinkSync(NODE_MODULES, join(dir, "node_modules"));
  }
  return dir;
}

let counter = 0;

async function load(dir: string, source: string, name = "marbles.config") {
  counter += 1;
  const file = join(dir, `${name}-${String(counter)}.ts`);
  writeFileSync(
    file,
    `import { agent, schedule, step, workflow } from ${JSON.stringify(LIB)};\n${source}`
  );
  return await import(pathToFileURL(file).href);
}

test("a nameless definition takes its top-level const's name", async () => {
  const dir = configDir();
  await load(
    dir,
    `
export const review = step().do(() => 1);
export const implement = step()
  .describe("multi-line chain")
  .do(() => 2);
export const weekly = workflow(() => review({}));
schedule(implement).every("1h");
`
  );
  expect([...catalog.definitions.keys()]).toEqual([
    "review",
    "implement",
    "weekly",
  ]);
  // Each says where it was declared, for a collision to quote.
  expect(catalog.definitions.get("review")?.origin).toContain(
    `${dir}/marbles.config-`
  );
  expect(catalog.schedules.get("implement")).toMatchObject({
    label: "implement",
    workflow: "implement",
  });
});

test("a call inside a function or an inline argument stays nameless", async () => {
  const dir = configDir();
  const module = await load(
    dir,
    `
const make = () => step().do(() => 1);
export const a = make();
export const b = make();
export const both = [a.name, b.name];
export let failure = "";
try {
  schedule(step().do(() => 2)).every("1h");
} catch (error) {
  failure = String(error);
}
`
  );
  expect(module.both).toEqual([undefined, undefined]);
  expect(catalog.definitions.size).toBe(0);
  expect(module.failure).toContain("has no name");
  expect(module.failure).not.toContain("install typescript");
});

test("a definition passed to another inside one initializer stays nameless", async () => {
  const dir = configDir();
  const module = await load(
    dir,
    `
export const job = workflow(step().do(() => 42)({}));
export const named = workflow("named-flow", step().do(() => 1)({}));
export const chained = step()
  .describe("wrapped in parentheses and a cast")
  .do(() => 3) as unknown as { name?: string };
export const names = [job.name, named.name, chained.name];
`
  );
  expect(module.names).toEqual(["job", "named-flow", "chained"]);
  expect([...catalog.definitions.keys()].sort()).toEqual([
    "chained",
    "job",
    "named-flow",
  ]);
});

test("two files binding the same const name collide with both positions", async () => {
  const dir = configDir();
  await load(dir, "export const shared = step().do(() => 1);\n", "one");
  let failure = "";
  try {
    await load(dir, "export const shared = step().do(() => 2);\n", "two");
  } catch (error) {
    failure = String(error);
  }
  expect(failure).toContain('"shared" already registered');
  expect(failure).toContain("one-");
  expect(failure).toContain("two-");
  expect(failure).toContain("comes from a const");
});

test("the stack settings are restored after a capture", async () => {
  const dir = configDir();
  const before = Error.prepareStackTrace;
  const limit = Error.stackTraceLimit;
  await load(dir, "export const x = step().do(() => 1);\n");
  expect(Error.prepareStackTrace).toBe(before);
  expect(Error.stackTraceLimit).toBe(limit);
  expect(new Error("plain").stack).toContain("plain");
});

test("without typescript nothing is inferred and the error says to install it", async () => {
  const dir = configDir(true);
  const module = await load(
    dir,
    `
export const orphan = step().do(() => 1);
export let failure = "";
try {
  schedule(orphan).every("1h");
} catch (error) {
  failure = String(error);
}
`
  );
  expect(module.orphan.name).toBeUndefined();
  expect(catalog.definitions.size).toBe(0);
  expect(module.failure).toContain("install typescript");
});

test("an agent's id is its name, else its const, never its position among the others", async () => {
  const dir = configDir();
  const module = await load(
    dir,
    `
export const reviewer = agent({ prompt: "Review." });
export const writer = agent({ name: "docs-writer", prompt: "Write." });
export const ids = [reviewer.id, writer.id];
`
  );
  expect(module.ids).toEqual(["reviewer", "docs-writer"]);
});

test("a nameless agent outside a const is known by what it is, so reordering keeps its id", async () => {
  const dir = configDir();
  const make = (first: string, second: string) => `
const make = (prompt: string, provider?: string) => agent({ prompt, provider });
export const ids = Object.fromEntries(
  [${first}, ${second}].map((made) => [made.prompt, made.id])
);
`;
  const one = await load(
    dir,
    make('make("Review.")', 'make("Write.", "codex")')
  );
  catalog.reset();
  const two = await load(
    dir,
    make('make("Write.", "codex")', 'make("Review.")')
  );
  expect(two.ids).toEqual(one.ids);
  expect(Object.values(one.ids)).toEqual([
    expect.stringMatching(AGENT_DIGEST),
    expect.stringMatching(AGENT_DIGEST),
  ]);
  expect(one.ids["Review."]).not.toBe(one.ids["Write."]);
});
