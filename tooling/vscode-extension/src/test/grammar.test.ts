// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are TypeScript and prompt source under test, so `${…}` is meant literally.
import { readFileSync } from "node:fs";
import {
  claudeCode,
  codex,
  type Dialect,
  HIGHLIGHT_SCOPES,
  Parser,
  pi,
} from "@foundry/prompts";
import { describe, expect, it } from "vitest";
import { grammars } from "../grammar";
import {
  contributedGrammars,
  foreground,
  type Highlight,
  highlight,
  type Painted,
  paint,
  THEMES,
  tokenTypes,
} from "./helpers/textmate";

const SUBSTITUTION = /\$\{[^}]*\}/;

/** What the parser reads in a template literal's body: every reference and escape, holes left out. */
function parsed(dialect: Dialect, body: string): Highlight[] {
  return new Parser(dialect)
    .tokenizeTemplate(body.split(SUBSTITUTION))
    .filter((token) => "reference" in token || token.kind === "escape")
    .map(({ kind, text }) => ({ kind, text }));
}

/** Every scope a grammar gives a token: its `name` and `contentName` values. */
function tokenScopes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(tokenScopes);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    (key === "name" || key === "contentName") && typeof child === "string"
      ? child.split(" ")
      : tokenScopes(child)
  );
}

const DIALECTS = [
  {
    dialect: claudeCode,
    samples: [
      '/code-review on @src/auth, then ask @"reviewer (agent)".',
      "/clear",
      "  /compact first, then /clear",
      "/clear-all is a skill, and so is /plugin:skill.",
      "a/b, user@host, US$5, and https://example.com/x are plain text",
      "Files: @src/a.ts, @docs/. and (@lib/b.ts)",
      "$ARGUMENTS, $ARGUMENTS[1], $0, and $name, but not $ARGUMENTSX or $Upper",
      "Review @${file} with /review",
      "${skill} /review after a hole",
      "First line\n/review mid-message\n  then $1",
    ],
    tag: "claude",
  },
  {
    dialect: codex,
    samples: [
      "/review the diff",
      "/prompts:draft FILE=notes.md",
      "use $review and $plugin:skill on @src/x.ts.",
      "$ARGUMENTS $1 $FILE costs $$5",
      "$$${amount}",
      "!ls -la",
      "say /review is plain mid-message",
    ],
    tag: "codex",
  },
  {
    dialect: pi,
    samples: [
      "/skill:review the diff",
      "/clear",
      "/draft a template",
      "$1 and $@ but not $ARGUMENTS",
      "!git status",
      "read @README.md",
    ],
    tag: "pi",
  },
] as const;

describe("tagged templates highlight what the parser reads", () => {
  for (const { dialect, samples, tag } of DIALECTS) {
    for (const sample of samples) {
      it(`${tag}: ${JSON.stringify(sample)}`, async () => {
        const source = `const prompt = prompts.${tag}\`${sample}\`;`;
        expect(await highlight("typescript", source)).toEqual(
          parsed(dialect, sample)
        );
      });
    }
  }
});

describe("tagged templates in TypeScript", () => {
  it("reads any qualifier before the dialect member", async () => {
    const source = "const p = this.mine.codex`use $review`;";
    expect(await highlight("typescript", source)).toEqual([
      { kind: "skill", text: "$review" },
    ]);
  });

  it("reads a plain-string call", async () => {
    const source = [
      'prompts.codex("use $review");',
      "prompts.claude('/clear');",
    ].join("\n");
    expect(await highlight("typescript", source)).toEqual([
      { kind: "skill", text: "$review" },
      { kind: "command", text: "/clear" },
    ]);
  });

  it("highlights template-only notation written with its source escapes", async () => {
    const source =
      "prompts.claude`Read \\${CLAUDE_SKILL_DIR}/x, run !\\`git status\\``;";
    expect(await highlight("typescript", source)).toEqual([
      { kind: "variable", text: "\\${CLAUDE_SKILL_DIR}" },
      { kind: "shell", text: "!\\`git status\\`" },
    ]);
  });

  it("leaves other templates, strings, and comments alone", async () => {
    const source = [
      "const a = html`/review @src`;",
      'const b = "/review @src";',
      "// prompts.claude`/review`",
      "const c = `/review`;",
    ].join("\n");
    expect(await highlight("typescript", source)).toEqual([]);
  });

  it("ends the prompt at its closing backtick", async () => {
    const source = "const p = prompts.claude`see @src`; const q = `/review`;";
    expect(await highlight("typescript", source)).toEqual([
      { kind: "file", text: "@src" },
    ]);
  });

  it("keeps the prompt a string to the editor", async () => {
    // A string, not code: brackets in prose are not matched or coloured,
    // and quotes are not auto-closed.
    const types = await tokenTypes(
      "typescript",
      'prompts.claude`see (a) /review`; prompts.codex("use [b] $review");'
    );
    for (const part of ["(a)", "/review", "[b]", "$review"]) {
      const run = types.find(({ text }) => text.includes(part));
      expect(run?.type, part).toBe("string");
    }
  });

  it("highlights a prompt nested in a substitution", async () => {
    const source = "prompts.claude`Use ${prompts.codex`$review`} /now`;";
    expect(await highlight("typescript", source)).toEqual([
      { kind: "skill", text: "$review" },
      { kind: "skill", text: "/now" },
    ]);
  });
});

describe("known differences from the parser", () => {
  it("opens a message only on the backtick's own line", async () => {
    // The parser skips blank lines to find the message start; a grammar
    // matches one line at a time, so a command on the next line reads as a skill.
    const sample = "\n/clear";
    expect(parsed(claudeCode, sample)).toEqual([
      { kind: "command", text: "/clear" },
    ]);
    expect(
      await highlight("typescript", `prompts.claude\`${sample}\``)
    ).toEqual([{ kind: "skill", text: "/clear" }]);
  });

  it("does not open a reference right after a substitution", async () => {
    // The parser scans each chunk on its own, so a sigil opening the chunk
    // after a hole sits at a boundary. Raw, it follows a `}`, which is no
    // boundary in prose, so the grammar leaves it.
    expect(parsed(claudeCode, "${skill}/review")).toEqual([
      { kind: "skill", text: "/review" },
    ]);
    expect(
      await highlight("typescript", "prompts.claude`${skill}/review`")
    ).toEqual([]);
  });

  it("does not read an escaped dollar as a placeholder", async () => {
    // Cooked, `\$ARGUMENTS` is `$ARGUMENTS`; raw, the backslash is no sigil boundary.
    expect(parsed(claudeCode, "$ARGUMENTS")).toEqual([
      { kind: "argument", text: "$ARGUMENTS" },
    ]);
    expect(
      await highlight("typescript", "prompts.claude`\\$ARGUMENTS`")
    ).toEqual([]);
  });
});

const SKILL = `---
name: review
description: Use /review on @src
---
# Review

Run /code-review on @src/auth, then ask @"reviewer (agent)".
Arguments: $ARGUMENTS, $0, $name. Status: !\`git status\`.
References live in \${CLAUDE_SKILL_DIR}/refs.

Not \`/in-code\`, nor a [link](/docs/page).

\`\`\`sh
/fenced @code
\`\`\`
`;

describe("skill files", () => {
  it("highlights the body as a Claude Code template", async () => {
    const prose = SKILL.split("\n").slice(6, 9).join("\n");
    const expected = new Parser(claudeCode)
      .tokenize(prose)
      .filter((token) => "reference" in token)
      .map(({ kind, text }) => ({ kind, text }));
    expect(expected.length).toBe(8);
    expect(await highlight("skill", SKILL)).toEqual(expected);
  });

  it("leaves plain markdown alone", async () => {
    expect(await highlight("markdown", SKILL)).toEqual([]);
  });
});

const UNCLOSED_SHELL_LINES = 16;
const UNCLOSED_SHELL_LENGTH = 4000;
const LINEAR_TIME_BUDGET_MS = 200;

describe("inline shell", () => {
  it("highlights a closed shell and passes over a blank or unclosed one", async () => {
    const skill = "Run !`git status` here\nnot !` ` blank\nnor !`open";
    expect(await highlight("skill", skill)).toEqual([
      { kind: "shell", text: "!`git status`" },
    ]);
    const source = [
      "prompts.claude`Run !\\`ls\\` here",
      "not !\\` \\` blank",
      "nor !\\`open",
      "but !\\`a\\\\\\` is`;",
    ].join("\n");
    expect(await highlight("typescript", source)).toEqual([
      { kind: "shell", text: "!\\`ls\\`" },
      { kind: "shell", text: "!\\`a\\\\\\`" },
    ]);
  });

  it("passes over long unclosed shells in linear time", async () => {
    const body = "a".repeat(UNCLOSED_SHELL_LENGTH);
    const lines = (open: string) =>
      Array.from({ length: UNCLOSED_SHELL_LINES }, () => `${open}${body}`);
    const skill = lines("!`").join("\n");
    const source = `prompts.claude\`\n${lines("!\\`").join("\n")}\n\`;`;
    await highlight("skill", "warm up");
    const started = performance.now();
    const found = [
      ...(await highlight("skill", skill)),
      ...(await highlight("typescript", source)),
    ];
    const elapsed = performance.now() - started;
    expect(found).toEqual([]);
    expect(elapsed).toBeLessThan(LINEAR_TIME_BUDGET_MS);
  });
});

/** Every kind a prompt can reference, each written once, around plain text. */
const ALL_KINDS_TS = [
  "prompts.claude`/clear plain`;",
  'prompts.claude`plain /review @src @"r (agent)" $ARGUMENTS \\${CLAUDE_SKILL_DIR} !\\`ls\\``;',
  "prompts.codex`/prompts:draft plain $$5`;",
].join("\n");
const ALL_KINDS_SKILL =
  'Run /review on @src, ask @"r (agent)" with $ARGUMENTS, !`ls`, and ${CLAUDE_SKILL_DIR}.';

function kindsIn(painted: readonly Painted[]): string[] {
  return [
    ...new Set(painted.flatMap(({ kind }) => (kind ? [kind] : []))),
  ].sort();
}

describe("stock themes set every reference apart", () => {
  for (const theme of THEMES) {
    it(`${theme}: from the string around it in TypeScript`, async () => {
      const painted = await paint("typescript", ALL_KINDS_TS, theme);
      expect(kindsIn(painted)).toEqual(
        Object.keys(HIGHLIGHT_SCOPES)
          .filter((kind) => !["hole", "mcp", "text"].includes(kind))
          .sort()
      );
      const string = painted.find(({ text }) => text.includes("plain"))?.color;
      for (const { color, kind, text } of painted) {
        if (kind) {
          expect(color, `${kind} ${text}`).not.toBe(string);
        }
      }
    });

    it(`${theme}: from the prose around it in skill files`, async () => {
      const painted = await paint("skill", ALL_KINDS_SKILL, theme);
      expect(kindsIn(painted)).toEqual([
        "agent",
        "argument",
        "file",
        "shell",
        "skill",
        "variable",
      ]);
      const prose = await foreground(theme);
      for (const { color, kind, text } of painted) {
        if (kind) {
          expect(color.toUpperCase(), `${kind} ${text}`).not.toBe(
            prose.toUpperCase()
          );
        }
      }
    });
  }
});

describe("the manifest", () => {
  it("contributes the grammars as src/grammar.ts builds them", () => {
    // Out of date: run `bun run grammar`.
    for (const [file, grammar] of Object.entries(grammars())) {
      const written = readFileSync(
        new URL(`../../syntaxes/${file}`, import.meta.url),
        "utf8"
      );
      expect(JSON.parse(written), file).toEqual(grammar);
    }
  });

  it("uses only the scopes the parser's token kinds map to", () => {
    const scopes = new Set(Object.values(HIGHLIGHT_SCOPES));
    const used = tokenScopes(contributedGrammars()).filter((scope) =>
      scope.endsWith(".prompt")
    );
    expect(used.length).toBeGreaterThan(0);
    for (const scope of used) {
      expect(scopes).toContain(scope);
    }
  });
});
