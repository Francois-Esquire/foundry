import { readFileSync } from "node:fs";
import { join } from "node:path";
import tsParser from "@typescript-eslint/parser";
import { type Rule, RuleTester } from "eslint";
import { describe, it } from "vitest";
import plugin from "../index";
import { FIXTURES, RULE_NAMES } from "./helpers/lint";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: "latest",
    parser: tsParser,
    sourceType: "module",
  },
});

type RuleName = (typeof RULE_NAMES)[number];

interface Expected {
  readonly column: number;
  readonly endColumn: number;
  readonly endLine?: number;
  readonly line: number;
  readonly message: string;
  readonly rule: RuleName;
}

const ruleOf = (name: RuleName) => {
  const rule = plugin.rules[name];
  if (rule === undefined) {
    throw new Error(`no rule ${name}`);
  }
  return rule as unknown as Rule.RuleModule;
};

const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

const templateOnly = (dialect: string, text: string) =>
  `${dialect} substitutes "${text}" only inside a skill or template file; in a message it is sent as literal text.`;
const consumed = (dialect: string, text: string) =>
  `${dialect} handles "${text}" itself; the model does not receive this message.`;

/** Every finding in the fixtures with nothing configured: the two name-free checks. */
const EXPECTED: Readonly<Record<string, readonly Expected[]>> = {
  "claude-code.ts": [
    {
      column: 37,
      endColumn: 43,
      line: 4,
      message: consumed("Claude Code", "/clear"),
      rule: "no-consumed-by-harness",
    },
    {
      column: 14,
      endColumn: 24,
      line: 13,
      message: templateOnly("Claude Code", "$ARGUMENTS"),
      rule: "no-template-only",
    },
    {
      column: 26,
      endColumn: 39,
      line: 13,
      message: templateOnly("Claude Code", "$ARGUMENTS[0]"),
      rule: "no-template-only",
    },
    {
      column: 41,
      endColumn: 43,
      line: 13,
      message: templateOnly("Claude Code", "$1"),
      rule: "no-template-only",
    },
    {
      column: 49,
      endColumn: 55,
      line: 13,
      message: templateOnly("Claude Code", "$topic"),
      rule: "no-template-only",
    },
    // Written `\${CLAUDE_SKILL_DIR}` in source: the span starts on the backslash and covers 20 characters, not 19.
    {
      column: 8,
      endColumn: 28,
      line: 14,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source under test.
      message: templateOnly("Claude Code", "${CLAUDE_SKILL_DIR}"),
      rule: "no-template-only",
    },
    // Written `!\`git branch --show-current\``: two escaped backticks widen the span by two.
    {
      column: 19,
      endColumn: 49,
      line: 15,
      message: templateOnly("Claude Code", "!`git branch --show-current`"),
      rule: "no-template-only",
    },
    {
      column: 39,
      endColumn: 47,
      line: 19,
      message: consumed("Claude Code", "/compact"),
      rule: "no-consumed-by-harness",
    },
  ],
  "codex.ts": [
    {
      column: 37,
      endColumn: 44,
      line: 4,
      message: consumed("Codex", "/review"),
      rule: "no-consumed-by-harness",
    },
    {
      column: 49,
      endColumn: 54,
      line: 9,
      message: templateOnly("Codex", "$FILE"),
      rule: "no-template-only",
    },
    {
      column: 60,
      endColumn: 62,
      line: 9,
      message: templateOnly("Codex", "$1"),
      rule: "no-template-only",
    },
    {
      column: 36,
      endColumn: 55,
      line: 12,
      message: consumed("Codex", "!git status --short"),
      rule: "no-consumed-by-harness",
    },
  ],
  "custom.ts": [],
  "pi.ts": [
    {
      column: 35,
      endColumn: 43,
      line: 6,
      message: consumed("Pi", "/compact"),
      rule: "no-consumed-by-harness",
    },
    {
      column: 44,
      endColumn: 46,
      line: 8,
      message: templateOnly("Pi", "$1"),
      rule: "no-template-only",
    },
    {
      column: 53,
      endColumn: 55,
      line: 8,
      message: templateOnly("Pi", "$@"),
      rule: "no-template-only",
    },
    {
      column: 33,
      endColumn: 40,
      line: 9,
      message: consumed("Pi", "!ls -la"),
      rule: "no-consumed-by-harness",
    },
  ],
};

const NAMES = {
  agents: ["reviewer"],
  skills: ["code-review", "security", "test-plan", "plugin:lint", "review"],
};

describe("fixtures", () => {
  for (const rule of RULE_NAMES) {
    const valid: RuleTester.ValidTestCase[] = [];
    const invalid: RuleTester.InvalidTestCase[] = [];
    for (const [file, expected] of Object.entries(EXPECTED)) {
      const errors = expected
        .filter((item) => item.rule === rule)
        .map(({ rule: _rule, endLine, ...rest }) => ({
          ...rest,
          endLine: endLine ?? rest.line,
        }));
      const code = fixture(file);
      const cases = [
        { code, filename: file, name: `${file} with nothing configured` },
        {
          code,
          filename: file,
          name: `${file} with every name listed`,
          settings: {
            foundryPrompts: { ...NAMES, dialects: { house: "claude" } },
          },
        },
      ];
      for (const item of cases) {
        if (errors.length === 0) {
          valid.push(item);
        } else {
          invalid.push({ ...item, errors });
        }
      }
    }
    valid.push({
      code: fixture("claude-code.ts"),
      name: "claude-code.ts read as a template",
      settings: { foundryPrompts: { surface: "template" } },
      ...(rule === "no-consumed-by-harness"
        ? {
            code: fixture("pi.ts")
              .replace("/compact", "/skill:x")
              .replace("!ls -la", "ls"),
          }
        : {}),
    });
    tester.run(rule, ruleOf(rule), { invalid, valid });
  }
});

describe("no-unresolved-reference", () => {
  tester.run("no-unresolved-reference", ruleOf("no-unresolved-reference"), {
    invalid: [
      {
        code: "prompts.claude`/nope now`;",
        errors: [
          {
            column: 16,
            endColumn: 21,
            line: 1,
            message: 'Unknown skill "nope".',
          },
        ],
        settings: { foundryPrompts: { skills: ["review"] } },
      },
      {
        code: 'prompts.claude`ask @"nobody (agent)"`;',
        errors: [
          {
            column: 20,
            endColumn: 37,
            line: 1,
            message: 'Unknown agent "nobody".',
          },
        ],
        settings: { foundryPrompts: { agents: [] } },
      },
      {
        // A command Codex does not have is checked against the built-ins with nothing configured.
        code: "prompts.codex`/nope`;",
        errors: [
          {
            column: 15,
            endColumn: 20,
            line: 1,
            message: 'Unknown command "nope".',
          },
        ],
      },
      {
        code: "mine.house`/nope`;",
        errors: [
          {
            column: 12,
            endColumn: 17,
            line: 1,
            message: 'Unknown skill "nope".',
          },
        ],
        settings: {
          foundryPrompts: { dialects: { house: "claude" }, skills: [] },
        },
      },
      {
        // A string argument, through its own escapes.
        code: "prompts.claude('say \\'hi\\' then /nope');",
        errors: [
          {
            column: 33,
            endColumn: 38,
            line: 1,
            message: 'Unknown skill "nope".',
          },
        ],
        settings: { foundryPrompts: { skills: [] } },
      },
      {
        code: "prompts.claude(`/nope`);",
        errors: [
          {
            column: 17,
            endColumn: 22,
            line: 1,
            message: 'Unknown skill "nope".',
          },
        ],
        settings: { foundryPrompts: { skills: [] } },
      },
      {
        // A multi-line template keeps line and column.
        code: "const p = prompts.claude`\n  first\n  then /nope\n`;",
        errors: [
          {
            column: 8,
            endColumn: 13,
            line: 3,
            message: 'Unknown skill "nope".',
          },
        ],
        settings: { foundryPrompts: { skills: [] } },
      },
    ],
    valid: [
      { code: "prompts.claude`/nope`;" },
      {
        code: "prompts.claude`/review`;",
        settings: { foundryPrompts: { skills: ["review"] } },
      },
      // A hole is dynamic, never unknown.
      {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: source under test.
        code: "prompts.claude`/${name} and @${file}`;",
        settings: { foundryPrompts: { skills: [] } },
      },
      // Not prompts: a call with two arguments, a substitution, a computed member, another member, no member.
      {
        code: "prompts.claude('/nope', 1);",
        settings: { foundryPrompts: { skills: [] } },
      },
      {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: source under test.
        code: "prompts.claude(`/${x}`);",
        settings: { foundryPrompts: { skills: [] } },
      },
      {
        code: "prompts['claude']`/nope`;",
        settings: { foundryPrompts: { skills: [] } },
      },
      {
        code: "prompts.house`/nope`;",
        settings: { foundryPrompts: { skills: [] } },
      },
      { code: "claude`/nope`;", settings: { foundryPrompts: { skills: [] } } },
      {
        code: "prompts.claude(nope);",
        settings: { foundryPrompts: { skills: [] } },
      },
      // An element whose cooked text is null is skipped.
      {
        code: "prompts.claude`\\unicode /nope`;",
        settings: { foundryPrompts: { skills: [] } },
      },
    ],
  });
});

describe("no-foreign-notation", () => {
  tester.run("no-foreign-notation", ruleOf("no-foreign-notation"), {
    invalid: [
      {
        code: "prompts.claude`use $review`;",
        errors: [
          {
            column: 20,
            endColumn: 27,
            line: 1,
            message:
              '"$review" is Codex notation; Claude Code reads a skill as "/review".',
          },
        ],
        settings: { foundryPrompts: { skills: ["review"] } },
      },
      {
        code: "prompts.codex`/review-it now`;",
        errors: [
          {
            column: 15,
            endColumn: 25,
            line: 1,
            message:
              '"/review-it" is Claude Code notation; Codex reads a skill as "$review-it".',
          },
        ],
        settings: { foundryPrompts: { skills: ["review-it"] } },
      },
    ],
    valid: [
      { code: "prompts.claude`use $review`;" },
      {
        code: "prompts.claude`use $review`;",
        settings: { foundryPrompts: { skills: ["other"] } },
      },
      {
        code: "prompts.claude`costs $5`;",
        settings: { foundryPrompts: { skills: ["5"] } },
      },
    ],
  });
});
