import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CLAUDE_CODE_DEFAULT_MODELS } from "@foundry/models/claude-code";
import { CODEX_DEFAULT_MODELS } from "@foundry/models/codex";
import { expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const TABLE = join(ROOT, "docs/quirks/reference/models.md");
const SAMPLE_ROOTS = [
  join(ROOT, "docs/quirks"),
  join(ROOT, "apps/quirks/README.md"),
  join(ROOT, "skills/quirks-config/references/api.md"),
];

const ROW = /^\|\s*([a-z-]+)\s*\|[^|]*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|$/;
const PROVIDER_ROW = /^\|\s*(Claude Code|Codex)\s*\|([^|]*)\|$/;
const BODY_ROW = /^\|(?!\s*(?:Role|Provider)\b)(?!\s*-)/;
const ID = /`([^`]+)`/g;
const FENCE = /```[^\n]*\n([\s\S]*?)```/g;
const MODEL = /\bmodel:\s*"([^"]+)"/g;
const PAGE = /\.mdx?$/;

interface Row {
  claudeCode: string;
  codex: string;
  role: string;
}

/** Table body lines under a heading, up to the next heading. */
async function section(heading: string): Promise<string[]> {
  const text = await readFile(TABLE, "utf8");
  const start = text.indexOf(`\n## ${heading}\n`);
  expect(start, `models.md has a "## ${heading}" section`).toBeGreaterThan(-1);
  const rest = text.slice(start + heading.length + 5);
  const end = rest.indexOf("\n## ");
  return (end === -1 ? rest : rest.slice(0, end))
    .split("\n")
    .filter((line) => BODY_ROW.test(line));
}

async function rows(): Promise<Row[]> {
  const lines = await section("Roles");
  const unparsed = lines.filter((line) => !ROW.test(line));
  expect(unparsed, "every Roles row is | role | job | `id` | `id` |").toEqual(
    []
  );
  return lines.map((line) => {
    const [, role, claudeCode, codex] = ROW.exec(line) ?? [];
    return {
      claudeCode: claudeCode ?? "",
      codex: codex ?? "",
      role: role ?? "",
    };
  });
}

async function served(): Promise<{ claudeCode: string[]; codex: string[] }> {
  const table = { claudeCode: [] as string[], codex: [] as string[] };
  for (const line of await section("What each provider serves")) {
    const [, provider, ids] = PROVIDER_ROW.exec(line) ?? [];
    expect(provider, `provider row parses: ${line}`).toBeDefined();
    const key = provider === "Codex" ? "codex" : "claudeCode";
    table[key] = [...(ids ?? "").matchAll(ID)].map(([, id]) => id ?? "");
  }
  return table;
}

async function pages(entry: string): Promise<string[]> {
  if (PAGE.test(entry)) {
    return [entry];
  }
  const names = await readdir(entry, { recursive: true });
  return names
    .filter((name) => PAGE.test(name) && !name.startsWith("_"))
    .map((name) => join(entry, name));
}

async function sampledIds(): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  for (const root of SAMPLE_ROOTS) {
    for (const page of await pages(root)) {
      const text = await readFile(page, "utf8");
      for (const [, code] of text.matchAll(FENCE)) {
        for (const [, id] of (code ?? "").matchAll(MODEL)) {
          const where = found.get(id ?? "") ?? [];
          where.push(page.slice(ROOT.length + 1));
          found.set(id ?? "", where);
        }
      }
    }
  }
  return found;
}

it("lists exactly the ids the providers serve", async () => {
  const table = await served();
  expect(table.claudeCode.toSorted()).toEqual(
    CLAUDE_CODE_DEFAULT_MODELS.map((m) => m.id).toSorted()
  );
  expect(table.codex.toSorted()).toEqual(
    CODEX_DEFAULT_MODELS.map((m) => m.id).toSorted()
  );
});

it("lists roles in the models table", async () => {
  const table = await rows();
  expect(table.length).toBeGreaterThan(0);
  expect(new Set(table.map((row) => row.role)).size).toBe(table.length);
});

it("pairs every role with ids the providers serve", async () => {
  const claudeCode = new Set(CLAUDE_CODE_DEFAULT_MODELS.map((m) => m.id));
  const codex = new Set(CODEX_DEFAULT_MODELS.map((m) => m.id));
  const unknown = (await rows()).flatMap((row) => [
    ...(claudeCode.has(row.claudeCode)
      ? []
      : [`${row.role}: Claude Code does not serve ${row.claudeCode}`]),
    ...(codex.has(row.codex)
      ? []
      : [`${row.role}: Codex does not serve ${row.codex}`]),
  ]);
  expect(unknown).toEqual([]);
});

it("uses only table ids in code samples", async () => {
  const known = new Set(
    (await rows()).flatMap((row) => [row.claudeCode, row.codex])
  );
  const sampled = await sampledIds();
  expect(sampled.size).toBeGreaterThan(0);
  const stray = [...sampled]
    .filter(([id]) => !known.has(id))
    .map(([id, where]) => `${id} in ${where.join(", ")}`);
  expect(stray).toEqual([]);
});
