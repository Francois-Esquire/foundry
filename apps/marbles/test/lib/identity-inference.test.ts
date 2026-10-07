/**
 * Name inference under a host that transpiles the module, as vitest does:
 * positions in the running code are not the source's, and the call site
 * has to come back through the host's source maps. The fixture puts types
 * and multi-line chains before and between definitions so a transform
 * shifts lines and columns.
 */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { catalog } from "~/authoring/catalog";
import { resetIdentity } from "~/authoring/identity";

const LIB = pathToFileURL(
  resolve(import.meta.dirname, "../../src/authoring/index.ts")
).href;
const NODE_MODULES = resolve(import.meta.dirname, "../../../../node_modules");
const DIFFERENT_AGENT = /agent "shared" already declared .*one-.*two-/;
const REPEATED_NAME =
  /"ship" already registered \(.*one-\d+\.ts:\d+\); second registration \(.*two-\d+\.ts:\d+\)/;

const dirs: string[] = [];

afterEach(() => {
  catalog.reset();
  resetIdentity();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

let counter = 0;

/** Write a module beside a `typescript` it can name from, and import it. */
async function load(source: string, name = "marbles.config") {
  const dir = mkdtempSync(join(tmpdir(), "marbles-inference-"));
  dirs.push(dir);
  symlinkSync(NODE_MODULES, join(dir, "node_modules"));
  counter += 1;
  const file = join(dir, `${name}-${String(counter)}.ts`);
  writeFileSync(
    file,
    `import { agent, step } from ${JSON.stringify(LIB)};\n${source}`
  );
  return await import(pathToFileURL(file).href);
}

it("names steps and agents from their consts through the host's source maps", async () => {
  const module = await load(`
interface Padding {
  readonly label: string;
  readonly weight: number;
}

const padding: Padding = { label: "x", weight: 1 };

export const alpha = agent({ prompt: "Alpha." });
export const beta = agent({ prompt: "Beta." } satisfies { prompt: string });

type Count = { readonly n: number };

export const gamma = step()
  .describe("after a type")
  .do((): Count => ({ n: padding.weight }));
export const writer = agent({ name: "docs-writer", prompt: "Write." });
export const ids = [alpha.id, beta.id, writer.id];
`);
  expect(module.ids).toEqual(["alpha", "beta", "docs-writer"]);
  expect([...catalog.definitions.keys()]).toEqual(["gamma"]);
});

it("refuses two different agents under one const name, quoting both", async () => {
  await load(`export const shared = agent({ prompt: "One." });\n`, "one");
  await expect(
    load(`export const shared = agent({ prompt: "Two." });\n`, "two")
  ).rejects.toThrow(DIFFERENT_AGENT);
});

it("lets the same agent be declared again", async () => {
  await load(`export const same = agent({ prompt: "Same." });\n`, "one");
  const again = await load(
    `export const same = agent({ prompt: "Same." });\n`,
    "two"
  );
  expect(again.same.id).toBe("same");
});

it("reports where both declarations of a repeated explicit name are", async () => {
  await load(`export const a = step("ship").do(() => 1);\n`, "one");
  await expect(
    load(`export const b = step("ship").do(() => 2);\n`, "two")
  ).rejects.toThrow(REPEATED_NAME);
});
