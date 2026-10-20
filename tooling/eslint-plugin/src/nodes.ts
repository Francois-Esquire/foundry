import { cookedToRaw, type Dialect } from "@foundry/prompts";
import type { ESTree } from "@oxlint/plugins";

/** A prompt found in source: its dialect, its cooked chunks, and the way back to source offsets. */
export interface PromptNode {
  readonly chunks: readonly string[];
  readonly dialect: Dialect;
  /** A cooked span's `start` and `end` as offsets into the file. */
  toSource(start: number, end: number): readonly [number, number];
}

interface Chunk {
  readonly cookedEnd: number;
  readonly cookedStart: number;
  /** Offset of the chunk's first raw character in the file. */
  readonly rawStart: number;
  readonly toRaw: (cooked: number) => number;
}

type Candidate = ESTree.CallExpression | ESTree.TaggedTemplateExpression;

/** The member name a tag or call is read through: `claude` in `prompts.claude`. */
function memberName(callee: ESTree.Expression): string | null {
  if (callee.type !== "MemberExpression" || callee.computed) {
    return null;
  }
  const { property } = callee;
  return property.type === "Identifier" ? property.name : null;
}

/** No notation spans a hole, so a span starts and ends in one chunk; a span at the very end belongs to the last. */
function mapping(chunks: readonly Chunk[]): PromptNode["toSource"] {
  return (start, end) => {
    const chunk =
      chunks.find(
        (item) => item.cookedStart <= start && start < item.cookedEnd
      ) ?? chunks.at(-1);
    if (chunk === undefined) {
      return [0, 0];
    }
    return [
      chunk.rawStart + chunk.toRaw(start - chunk.cookedStart),
      chunk.rawStart + chunk.toRaw(end - chunk.cookedStart),
    ];
  };
}

/**
 * A `TemplateElement`'s range covers its delimiters too: the opening
 * backtick or `}` before it and the `${` or closing backtick after. ESLint's
 * parsers and Oxlint agree, so the raw text starts one character in.
 */
function fromTemplate(
  dialect: Dialect,
  literal: ESTree.TemplateLiteral
): PromptNode | null {
  const chunks: Chunk[] = [];
  const cooked: string[] = [];
  let offset = 0;
  for (const element of literal.quasis) {
    if (element.value.cooked === null) {
      return null;
    }
    const text = element.value.cooked;
    chunks.push({
      cookedEnd: offset + text.length,
      cookedStart: offset,
      rawStart: element.range[0] + 1,
      toRaw: cookedToRaw(element.value.raw),
    });
    cooked.push(text);
    offset += text.length;
  }
  return { chunks: cooked, dialect, toSource: mapping(chunks) };
}

/** A string literal's range covers its quotes; the raw text starts one character in. */
function fromString(
  dialect: Dialect,
  literal: ESTree.StringLiteral,
  text: string
): PromptNode {
  const raw = (
    literal.raw ?? text.slice(literal.range[0], literal.range[1])
  ).slice(1, -1);
  const chunk: Chunk = {
    cookedEnd: literal.value.length,
    cookedStart: 0,
    rawStart: literal.range[0] + 1,
    toRaw: cookedToRaw(raw),
  };
  return { chunks: [literal.value], dialect, toSource: mapping([chunk]) };
}

/**
 * The prompt a node holds, or `null` when it is not one. A tagged template
 * `x.claude\`…\`` counts for any `x`; so does a call `x.claude("…")` whose
 * only argument is a string literal or a template literal with no
 * substitutions. The member name picks the dialect from `dialects`.
 */
export function promptOf(
  node: Candidate,
  dialects: Readonly<Record<string, Dialect>>,
  text: string
): PromptNode | null {
  if (node.type === "TaggedTemplateExpression") {
    const dialect = dialects[memberName(node.tag) ?? ""];
    return dialect === undefined ? null : fromTemplate(dialect, node.quasi);
  }
  const dialect = dialects[memberName(node.callee) ?? ""];
  const [argument] = node.arguments;
  if (
    dialect === undefined ||
    node.arguments.length !== 1 ||
    argument === undefined
  ) {
    return null;
  }
  if (argument.type === "TemplateLiteral") {
    return argument.expressions.length === 0
      ? fromTemplate(dialect, argument)
      : null;
  }
  if (argument.type === "Literal" && typeof argument.value === "string") {
    return fromString(dialect, argument as ESTree.StringLiteral, text);
  }
  return null;
}
