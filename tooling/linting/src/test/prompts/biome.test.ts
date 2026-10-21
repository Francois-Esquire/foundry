import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gritRules } from "../../prompts/grit";
import {
  type BiomeFinding,
  FIXTURES,
  GRIT,
  lintWithBiome,
  lintWithEslint,
} from "../helpers/lint";

const FILES = ["claude-code.ts", "codex.ts", "custom.ts", "pi.ts"];
/** The codes Biome can check without a list of names. */
const BIOME_CODES = new Set(["consumed-by-harness", "template-only"]);

/** A point is inside a range, comparing (line, column) pairs. */
function within(
  point: { line: number; column: number },
  range: BiomeFinding
): boolean {
  const afterStart =
    point.line > range.line ||
    (point.line === range.line && point.column >= range.column);
  const beforeEnd =
    point.line < range.endLine ||
    (point.line === range.endLine && point.column <= range.endColumn);
  return afterStart && beforeEnd;
}

/** A workspace with the fixtures copied in, since Biome reads a config beside the files. */
function workspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), "foundry-biome-"));
  for (const file of FILES) {
    copyFileSync(join(FIXTURES, file), join(cwd, file));
  }
  return cwd;
}

describe("biome", () => {
  it("commits what the generator writes", () => {
    for (const [name, text] of Object.entries(gritRules())) {
      expect(readFileSync(join(GRIT, name), "utf8"), name).toBe(text);
    }
  });

  it("reports the name-free checks where ESLint reports them", async () => {
    const cwd = workspace();
    const fromBiome = lintWithBiome(FILES, cwd);
    const fromEslint = (await lintWithEslint(FILES, undefined, cwd)).filter(
      (item) => BIOME_CODES.has(item.rule)
    );
    expect(fromBiome.length).toBeGreaterThan(0);
    // Every ESLint finding sits inside a Biome finding for the same code: Biome
    // underlines the chunk or the whole prompt, one finding per chunk.
    const uncovered = fromEslint.filter(
      (item) =>
        !fromBiome.some(
          (range) =>
            range.file === item.file &&
            range.rule === item.rule &&
            within(item, range)
        )
    );
    expect(uncovered).toEqual([]);
    // And every Biome finding covers at least one ESLint finding: nothing is invented.
    const invented = fromBiome.filter(
      (range) =>
        !fromEslint.some(
          (item) =>
            range.file === item.file &&
            range.rule === item.rule &&
            within(item, range)
        )
    );
    expect(invented).toEqual([]);
  });

  it("reads the edge cases the way the parser does", async () => {
    const cwd = workspace();
    const sample = [
      // A command only when it opens the message, and only a listed one.
      "x.claude`/clear`;",
      "x.claude`  /compact keep`;",
      "x.claude`/clearing`;",
      "x.claude`say /clear`;",
      "x.claude('/clear');",
      // Codex: any command but a custom prompt; a shell line but not inline shell.
      "x.codex`/nope`;",
      "x.codex`/prompts:draft`;",
      "x.codex`!git status`;",
      "x.codex`!\\`git status\\``;",
      "x.codex(`/review`);",
      // Pi: listed commands and shell lines; a skill or template is not consumed.
      "x.pi`/compact`;",
      "x.pi`/skill:review`;",
      "x.pi`/draft`;",
      "x.pi`!ls`;",
      // Placeholders in a message, per dialect.
      "x.claude`costs $5`;",
      "x.claude`costs $ARGUMENTSx`;",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source under test.
      "x.claude`a ${y}$1`;",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source under test.
      "x.claude`$1 ${y} $2`;",
      "x.codex`$FILE and $file`;",
      "x.codex`it costs $$5`;",
      "x.pi`$1 $@ $ARGUMENTS`;",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source under test.
      "x.claude('${CLAUDE_SKILL_DIR} and !`ls`');",
      // Not prompts.
      "x.house`/clear`;",
      "x['claude']`/clear`;",
      "x.claude('/clear', 1);",
      "",
    ].join("\n");
    writeFileSync(join(cwd, "sample.ts"), sample);
    const fromBiome = lintWithBiome(["sample.ts"], cwd);
    const fromEslint = (
      await lintWithEslint(["sample.ts"], undefined, cwd)
    ).filter((item) => BIOME_CODES.has(item.rule));
    const lines = (found: readonly { line: number; rule: string }[]) =>
      [...new Set(found.map((item) => `${item.line} ${item.rule}`))].sort();
    expect(lines(fromBiome)).toEqual(lines(fromEslint));
  });
});
