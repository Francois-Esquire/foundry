import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { Catalog, collectCatalog } from "~/authoring/catalog";

const LIB = pathToFileURL(
  resolve(import.meta.dirname, "../src/authoring/index.ts")
).href;
const AGENT_DIGEST = /^agent-[0-9a-f]{16}$/;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function configDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "marbles-identity-"));
  dirs.push(dir);
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
  const exports = (await import(pathToFileURL(file).href)) as Record<
    string,
    unknown
  >;
  return { exports, file };
}

test("an exported nameless definition takes its export key name without requiring typescript", async () => {
  const dir = configDir();
  const loaded = await load(
    dir,
    `
export const review = step().do(() => 1);
export const implement = step()
  .describe("multi-line chain")
  .do(() => 2);
export const weekly = workflow(() => review({}));
export const hourly = schedule(implement).every("1h");
`
  );
  const collected = collectCatalog(loaded);
  expect([...collected.definitions.keys()]).toEqual([
    "review",
    "implement",
    "weekly",
  ]);
  expect(collected.originOf("review")).toBe(loaded.file);
  expect(collected.definitions.get("review")).toBe(loaded.exports.review);
  expect(collected.schedules.get("implement")).toMatchObject({
    label: "implement",
    workflow: "implement",
  });
});

test("an unexported call stays nameless and scheduling it fails cleanly on collect", async () => {
  const dir = configDir();
  const loaded = await load(
    dir,
    `
const make = () => step().do(() => 1);
const a = make();
const b = make();
export const both = [a.name, b.name];
export const badSchedule = schedule(step().do(() => 2)).every("1h");
`
  );
  expect(loaded.exports.both).toEqual([undefined, undefined]);
  expect(() => collectCatalog(loaded)).toThrow("has no name");
  expect(() => collectCatalog(loaded)).not.toThrow("install typescript");
});

test("a definition passed to another inside one initializer stays nameless and explicit names win over export keys", async () => {
  const dir = configDir();
  const loaded = await load(
    dir,
    `
export const job = workflow(step().do(() => 42)({}));
export const named = workflow("named-flow", step().do(() => 1)({}));
export const chained = step()
  .describe("wrapped in parentheses and a cast")
  .do(() => 3) as unknown as { name?: string };
`
  );
  const collected = collectCatalog(loaded);
  expect([...collected.definitions.keys()].sort()).toEqual([
    "chained",
    "job",
    "named-flow",
  ]);
});

test("two files exporting the same name collide with both file origins", async () => {
  const dir = configDir();
  const one = await load(
    dir,
    "export const shared = step().do(() => 1);\n",
    "one"
  );
  const two = await load(
    dir,
    "export const shared = step().do(() => 2);\n",
    "two"
  );
  let failure = "";
  try {
    Catalog.collect([one, two]);
  } catch (error) {
    failure = String(error);
  }
  expect(failure).toContain('"shared" already registered');
  expect(failure).toContain("one-");
  expect(failure).toContain("two-");
  expect(failure).toContain("comes from an export");
});

test("an exported agent's id is its explicit name, else its export key", async () => {
  const dir = configDir();
  const loaded = await load(
    dir,
    `
export const reviewer = agent({ prompt: "Review." });
export const writer = agent({ name: "docs-writer", prompt: "Write." });
`
  );
  const collected = collectCatalog(loaded);
  expect([...collected.agents.keys()].sort()).toEqual([
    "docs-writer",
    "reviewer",
  ]);
  const reviewer = collected.agents.get("reviewer");
  expect(reviewer).toBe(loaded.exports.reviewer);
  expect(reviewer && collected.agentIdOf(reviewer)).toBe("reviewer");
  expect(collected.agents.get("docs-writer")?.id).toBe("docs-writer");
});

test("a factory keeps its agents' ids by naming them", async () => {
  const dir = configDir();
  const loaded = await load(
    dir,
    `
const reviewer = (who: string) =>
  agent({ name: \`review-\${who}\`, prompt: \`Review what \${who} wrote.\` });
export const ids = [reviewer("codex").id, reviewer("claude").id];
`
  );
  expect(loaded.exports.ids).toEqual(["review-codex", "review-claude"]);
});

test("a nameless agent outside an export is known by its content digest, so reordering keeps its id", async () => {
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
  const two = await load(
    dir,
    make('make("Write.", "codex")', 'make("Review.")')
  );
  const oneIds = one.exports.ids as Record<string, string>;
  const twoIds = two.exports.ids as Record<string, string>;
  expect(twoIds).toEqual(oneIds);
  expect(Object.values(oneIds)).toEqual([
    expect.stringMatching(AGENT_DIGEST),
    expect.stringMatching(AGENT_DIGEST),
  ]);
  expect(oneIds["Review."]).not.toBe(oneIds["Write."]);
});
