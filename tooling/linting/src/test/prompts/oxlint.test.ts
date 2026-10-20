import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES, lintWithEslint, lintWithOxlint } from "../helpers/lint";

const FILES = ["claude-code.ts", "codex.ts", "custom.ts", "pi.ts"];

describe("oxlint", () => {
  it("loads the bundle and reports what ESLint reports", async () => {
    const fromOxlint = lintWithOxlint(FILES, undefined, FIXTURES);
    const fromEslint = await lintWithEslint(FILES, undefined, FIXTURES);
    expect(fromOxlint.length).toBeGreaterThan(0);
    expect(fromOxlint).toEqual(fromEslint);
  });

  it("reads the shared settings", () => {
    const cwd = mkdtempSync(join(tmpdir(), "foundry-prompts-"));
    mkdirSync(join(cwd, ".claude/skills/code-review"), { recursive: true });
    mkdirSync(join(cwd, ".claude/agents"), { recursive: true });
    writeFileSync(join(cwd, ".claude/agents/reviewer.md"), "");
    writeFileSync(
      join(cwd, "sample.ts"),
      [
        'mine.house`/code-review @"reviewer (agent)"`;',
        'mine.house`/nope @"nobody (agent)" $code-review $ARGUMENTS`;',
        "",
      ].join("\n")
    );
    const found = lintWithOxlint(
      ["sample.ts"],
      {
        agents: [".claude/agents"],
        dialects: { house: "claude" },
        skills: [".claude/skills"],
        surface: "template",
      },
      cwd
    );
    expect(
      found.map((item) => [
        item.line,
        item.column,
        item.rule,
        item.severity,
        item.message,
      ])
    ).toEqual([
      [2, 12, "unresolved-reference", "error", 'Unknown skill "nope".'],
      [2, 18, "unresolved-reference", "error", 'Unknown agent "nobody".'],
      [
        2,
        36,
        "foreign-notation",
        "error",
        '"$code-review" is Codex notation; Claude Code reads a skill as "/code-review".',
      ],
    ]);
  });
});
