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

import { catalog } from "~/lib/catalog";
import { resetIdentity } from "~/lib/identity";

const LIB = pathToFileURL(resolve(import.meta.dir, "../src/lib/index.ts")).href;
const NODE_MODULES = resolve(import.meta.dir, "../../../node_modules");

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
  const dir = mkdtempSync(join(tmpdir(), "quirks-identity-"));
  dirs.push(dir);
  if (!bare) {
    symlinkSync(NODE_MODULES, join(dir, "node_modules"));
  }
  return dir;
}

let counter = 0;

async function load(dir: string, source: string, name = "quirks.config") {
  counter += 1;
  const file = join(dir, `${name}-${String(counter)}.ts`);
  writeFileSync(
    file,
    `import { schedule, step, workflow } from ${JSON.stringify(LIB)};\n${source}`
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
  expect(
    catalog.entries().map((entry) => [entry.name, entry.inferred])
  ).toEqual([
    ["review", true],
    ["implement", true],
    ["weekly", true],
  ]);
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
  expect(catalog.entries()).toEqual([]);
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
  expect(
    catalog
      .entries()
      .map((entry) => entry.name)
      .sort()
  ).toEqual(["chained", "job", "named-flow"]);
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

test("the stack formatter is restored after a capture", async () => {
  const dir = configDir();
  const before = Error.prepareStackTrace;
  await load(dir, "export const x = step().do(() => 1);\n");
  expect(Error.prepareStackTrace).toBe(before);
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
  expect(catalog.entries()).toEqual([]);
  expect(module.failure).toContain("install typescript");
});
