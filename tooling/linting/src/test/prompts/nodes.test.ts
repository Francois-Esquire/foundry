// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are TypeScript source under test, so `${…}` is meant literally.
import { claudeCode } from "@foundry/prompts";
import type { ESTree } from "@oxlint/plugins";
import { parse } from "@typescript-eslint/parser";
import { describe, expect, it } from "vitest";
import { type PromptNode, promptOf } from "../../prompts/nodes";

const MANY_HOLES = 40_000;
const LINEAR_TIME_BUDGET_MS = 200;

function promptIn(source: string): PromptNode {
  const program = parse(source, { range: true });
  const [statement] = program.body;
  if (statement?.type !== "ExpressionStatement") {
    throw new Error("expected an expression statement");
  }
  const prompt = promptOf(
    statement.expression as unknown as ESTree.TaggedTemplateExpression,
    { claude: claudeCode },
    source
  );
  if (prompt === null) {
    throw new Error("expected a prompt");
  }
  return prompt;
}

describe("prompt source positions", () => {
  it("maps every cooked offset to its character in the file, past empty chunks", () => {
    const source = "x.claude`${a}ab${b}${c}cd${d}`;";
    const prompt = promptIn(source);
    const cooked = prompt.chunks.join("");
    expect(cooked).toBe("abcd");
    for (const [offset, character] of [...cooked].entries()) {
      const [start, end] = prompt.toSource(offset, offset + 1);
      expect(source.slice(start, end)).toBe(character);
    }
  });

  it("maps the end of the text to the end of the last chunk", () => {
    const source = "x.claude`ab${a}`;";
    const prompt = promptIn(source);
    expect(prompt.toSource(2, 2)).toEqual([
      source.indexOf("}") + 1,
      source.indexOf("}") + 1,
    ]);
  });

  it("maps across escapes to raw offsets", () => {
    const source = "x.claude`a\\n${a}b\\tc`;";
    const prompt = promptIn(source);
    expect(prompt.chunks).toEqual(["a\n", "b\tc"]);
    const [start, end] = prompt.toSource(2, 5);
    expect(source.slice(start, end)).toBe("b\\tc");
  });

  it("maps a span in each of many chunks in linear time", () => {
    const source = `x.claude\`${"$1 ${a}".repeat(MANY_HOLES)}\`;`;
    const prompt = promptIn(source);
    const started = performance.now();
    const ranges = prompt.chunks.map((_, index) =>
      prompt.toSource(index * 3, index * 3 + 2)
    );
    const elapsed = performance.now() - started;
    expect(ranges.length).toBe(MANY_HOLES + 1);
    const last = ranges.at(-2);
    expect(last && source.slice(last[0], last[1])).toBe("$1");
    expect(elapsed).toBeLessThan(LINEAR_TIME_BUDGET_MS);
  });
});
