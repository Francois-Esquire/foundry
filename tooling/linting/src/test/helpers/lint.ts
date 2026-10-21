import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import tsParser from "@typescript-eslint/parser";
import { ESLint } from "eslint";
import type { PromptsSettings } from "../../index";

const require = createRequire(import.meta.url);

/** The extension's sample files: every notation per dialect. */
export const FIXTURES = resolve(
  import.meta.dirname,
  "../../../../vscode-extension/fixtures"
);

/** The bundle Node can load, for Oxlint and for the parity check. */
const DIST = resolve(import.meta.dirname, "../../../dist/index.js");

export const RULE_NAMES = [
  "consumed-by-harness",
  "foreign-notation",
  "template-only",
  "unresolved-reference",
] as const;

/** One reported problem, the same shape from either linter. */
export interface Finding {
  readonly column: number;
  readonly endColumn: number;
  readonly endLine: number;
  readonly file: string;
  readonly line: number;
  readonly message: string;
  readonly rule: string;
  readonly severity: "error" | "warning";
}

const SEVERITY: Readonly<Record<string, "error" | "warn">> = {
  "consumed-by-harness": "warn",
  "foreign-notation": "error",
  "template-only": "warn",
  "unresolved-reference": "error",
};

function rulesConfig(): Record<string, "error" | "warn"> {
  const rules: Record<string, "error" | "warn"> = {};
  for (const name of RULE_NAMES) {
    rules[`foundry/prompts/${name}`] = SEVERITY[name] ?? "error";
  }
  return rules;
}

function compare(a: Finding, b: Finding): number {
  return (
    a.file.localeCompare(b.file) ||
    a.line - b.line ||
    a.column - b.column ||
    a.rule.localeCompare(b.rule)
  );
}

/** Lint files with ESLint through the built bundle, the TypeScript parser, and every rule on. */
export async function lintWithEslint(
  files: readonly string[],
  settings: PromptsSettings | undefined,
  cwd: string
): Promise<Finding[]> {
  const { default: plugin } = (await import(DIST)) as {
    default: ESLint.Plugin;
  };
  const eslint = new ESLint({
    cwd,
    overrideConfig: [
      {
        files: ["**/*.ts"],
        languageOptions: {
          ecmaVersion: "latest",
          parser: tsParser,
          sourceType: "module",
        },
        plugins: { foundry: plugin },
        rules: rulesConfig(),
        settings:
          settings === undefined ? {} : { foundry: { prompts: settings } },
      },
    ],
    overrideConfigFile: true,
  });
  const results = await eslint.lintFiles([...files]);
  const found: Finding[] = [];
  for (const result of results) {
    for (const message of result.messages) {
      if (message.ruleId === null) {
        throw new Error(`ESLint: ${message.message}`);
      }
      found.push({
        column: message.column,
        endColumn: message.endColumn ?? message.column,
        endLine: message.endLine ?? message.line,
        file: result.filePath,
        line: message.line,
        message: message.message,
        rule: message.ruleId.replace("foundry/prompts/", ""),
        severity: message.severity === 2 ? "error" : "warning",
      });
    }
  }
  return found.sort(compare);
}

interface OxlintDiagnostic {
  readonly code: string;
  readonly filename: string;
  readonly labels: readonly {
    readonly span: {
      readonly column: number;
      readonly length: number;
      readonly line: number;
      readonly offset: number;
    };
  }[];
  readonly message: string;
  readonly severity: "error" | "warning";
}

const RULE_ID = /^foundry\(prompts\/(.+)\)$/;

/** Line and column, 1-based, of an offset into text; what ESLint reports. */
function locate(
  text: string,
  offset: number
): { column: number; line: number } {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");
  return { column, line };
}

/** Lint files with the `oxlint` binary, loading the built bundle as a JS plugin. */
export function lintWithOxlint(
  files: readonly string[],
  settings: PromptsSettings | undefined,
  cwd: string
): Finding[] {
  const binary = join(
    dirname(require.resolve("oxlint/package.json")),
    "bin/oxlint"
  );
  const config = join(
    mkdtempSync(join(tmpdir(), "foundry-oxlint-")),
    ".oxlintrc.json"
  );
  writeFileSync(
    config,
    JSON.stringify({
      categories: { correctness: "off" },
      jsPlugins: [DIST],
      plugins: [],
      rules: rulesConfig(),
      settings:
        settings === undefined ? {} : { foundry: { prompts: settings } },
    })
  );
  const run = spawnSync(binary, ["-c", config, "--format", "json", ...files], {
    cwd,
    encoding: "utf8",
  });
  if (run.error !== undefined) {
    throw run.error;
  }
  let parsed: { diagnostics: OxlintDiagnostic[] };
  try {
    parsed = JSON.parse(run.stdout) as { diagnostics: OxlintDiagnostic[] };
  } catch (error) {
    throw new Error(`oxlint: ${run.stderr}\n${run.stdout}`, { cause: error });
  }
  const found: Finding[] = [];
  const texts = new Map<string, string>();
  for (const item of parsed.diagnostics) {
    const rule = RULE_ID.exec(item.code)?.[1];
    const span = item.labels[0]?.span;
    if (rule === undefined || span === undefined) {
      throw new Error(`oxlint: ${item.code}: ${item.message}`);
    }
    const file = resolve(cwd, item.filename);
    const text = texts.get(file) ?? readFileSync(file, "utf8");
    texts.set(file, text);
    const end = locate(text, span.offset + span.length);
    found.push({
      column: span.column,
      endColumn: end.column,
      endLine: end.line,
      file,
      line: span.line,
      message: item.message,
      rule,
      severity: item.severity,
    });
  }
  return found.sort(compare);
}

/** The Biome rules as committed, loaded from `biome/`. */
export const GRIT = resolve(import.meta.dirname, "../../../biome");

/** A Biome finding: the rule named in the message, and the range it covers. */
export interface BiomeFinding {
  readonly column: number;
  readonly endColumn: number;
  readonly endLine: number;
  readonly file: string;
  readonly line: number;
  readonly rule: string;
}

interface BiomeDiagnostic {
  readonly category: string;
  readonly location: {
    readonly end: { readonly column: number; readonly line: number };
    readonly path: string;
    readonly start: { readonly column: number; readonly line: number };
  };
  readonly message: string;
  readonly severity: string;
}

const BIOME_RULE = /\(foundry\/prompts\/([a-z-]+)\)$/;

/** Lint files with the `biome` binary and only the generated prompt rules, no built-in ones. */
export function lintWithBiome(
  files: readonly string[],
  cwd: string
): BiomeFinding[] {
  const binary = join(
    dirname(require.resolve("@biomejs/biome/package.json")),
    "bin/biome"
  );
  const rules = [
    "prompts-consumed-by-harness.grit",
    "prompts-template-only.grit",
  ];
  writeFileSync(
    join(cwd, "biome.json"),
    JSON.stringify({
      formatter: { enabled: false },
      linter: { enabled: true, rules: { recommended: false } },
      plugins: rules.map((name) => join(GRIT, name)),
    })
  );
  const run = spawnSync(binary, ["lint", "--reporter=json", ...files], {
    cwd,
    encoding: "utf8",
  });
  if (run.error !== undefined) {
    throw run.error;
  }
  let parsed: { diagnostics: BiomeDiagnostic[] };
  try {
    parsed = JSON.parse(run.stdout) as { diagnostics: BiomeDiagnostic[] };
  } catch (error) {
    throw new Error(`biome: ${run.stderr}\n${run.stdout}`, { cause: error });
  }
  const found: BiomeFinding[] = [];
  for (const item of parsed.diagnostics) {
    if (item.category !== "plugin") {
      if (item.severity === "info") {
        continue;
      }
      throw new Error(`biome: ${item.category}: ${item.message}`);
    }
    const rule = BIOME_RULE.exec(item.message)?.[1];
    if (rule === undefined || item.severity !== "warning") {
      throw new Error(`biome: ${item.severity}: ${item.message}`);
    }
    found.push({
      column: item.location.start.column,
      endColumn: item.location.end.column,
      endLine: item.location.end.line,
      file: resolve(cwd, item.location.path),
      line: item.location.start.line,
      rule,
    });
  }
  return found.sort(
    (a, b) =>
      a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column
  );
}
