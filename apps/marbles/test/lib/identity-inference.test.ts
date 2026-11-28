import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { Catalog, collectCatalog } from "~/authoring/catalog";
import { startEngine } from "../helpers/engine";

const LIB = pathToFileURL(
  resolve(import.meta.dirname, "../../src/authoring/index.ts")
).href;
const DIFFERENT_AGENT = /agent "shared" already declared .*one-.*two-/;
const ANOTHER_FUNCTION =
  /agent "routed" already declared by another function \(.*one-\d+\.ts\) \(.*two-\d+\.ts\)/;
const REPEATED_NAME =
  /"ship" already registered \(.*one-\d+\.ts\); second registration \(.*two-\d+\.ts\)/;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

let counter = 0;

async function load(source: string, name = "marbles.config") {
  const dir = mkdtempSync(join(tmpdir(), "marbles-inference-"));
  dirs.push(dir);
  counter += 1;
  const file = join(dir, `${name}-${String(counter)}.ts`);
  writeFileSync(
    file,
    `import { agent, step } from ${JSON.stringify(LIB)};\n${source}`
  );
  const exports = (await import(pathToFileURL(file).href)) as Record<
    string,
    unknown
  >;
  return { exports, file };
}

it("names steps and agents from their exports cleanly without source maps or typescript", async () => {
  const loaded = await load(`
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
`);
  const collected = collectCatalog(loaded);
  expect([...collected.agents.keys()].sort()).toEqual([
    "alpha",
    "beta",
    "docs-writer",
  ]);
  expect([...collected.definitions.keys()]).toEqual(["gamma"]);
});

it("names an agent declared with a function from its export, and does not run it", async () => {
  const loaded = await load(`
let runs = 0;
export const routed = agent(async () => {
  runs += 1;
  return { prompt: "Routed." };
});
export const ran = () => runs;
`);
  const collected = collectCatalog(loaded);
  const routed = collected.agents.get("routed");
  expect(routed).toBe(loaded.exports.routed);
  expect(routed && collected.agentIdOf(routed)).toBe("routed");
  expect((loaded.exports.ran as () => number)()).toBe(0);

  if (routed === undefined) {
    throw new Error("expected routed agent");
  }
  const engine = await startEngine({
    catalog: collected,
    print: () => undefined,
  });
  try {
    const session = await engine.agents.session(routed);
    const reply = await session.generate("check");
    expect(reply.text).toContain("check");
    const usage = await engine.readUsage();
    const [first] = usage.facts;
    expect(first && "agentId" in first ? first.agentId : undefined).toBe(
      "routed"
    );
  } finally {
    await engine.dispose();
  }
});

it("refuses a second function agent under one export name, even from the same source", async () => {
  const source = `export const routed = agent(() => ({ prompt: "Routed." }));\n`;
  const one = await load(source, "one");
  const two = await load(source, "two");
  expect(() => Catalog.collect([one, two])).toThrow(ANOTHER_FUNCTION);
});

it("refuses two different agents under one export name, quoting both", async () => {
  const one = await load(
    `export const shared = agent({ prompt: "One." });\n`,
    "one"
  );
  const two = await load(
    `export const shared = agent({ prompt: "Two." });\n`,
    "two"
  );
  expect(() => Catalog.collect([one, two])).toThrow(DIFFERENT_AGENT);
});

it("lets the same agent be declared again", async () => {
  const one = await load(
    `export const same = agent({ prompt: "Same." });\n`,
    "one"
  );
  const two = await load(
    `export const same = agent({ prompt: "Same." });\n`,
    "two"
  );
  const collected = Catalog.collect([one, two]);
  const same = collected.agents.get("same");
  expect(same).toBe(one.exports.same);
  expect(same && collected.agentIdOf(same)).toBe("same");
});

it("reports where both declarations of a repeated explicit name are", async () => {
  const one = await load(`export const a = step("ship").do(() => 1);\n`, "one");
  const two = await load(`export const b = step("ship").do(() => 2);\n`, "two");
  expect(() => Catalog.collect([one, two])).toThrow(REPEATED_NAME);
});
