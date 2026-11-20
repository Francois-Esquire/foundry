import { cookedToRaw, type Dialect } from "@foundry/prompts";
import type { ESTree } from "@oxlint/plugins";

export interface PromptNode {
  readonly chunks: readonly string[];
  readonly dialect: Dialect;
  toSource(start: number, end: number): readonly [number, number];
}

interface Chunk {
  readonly cookedEnd: number;
  readonly cookedStart: number;
  readonly rawStart: number;
  readonly toRaw: (cooked: number) => number;
}

type Candidate = ESTree.CallExpression | ESTree.TaggedTemplateExpression;

function memberName(callee: ESTree.Expression): string | null {
  if (callee.type !== "MemberExpression" || callee.computed) {
    return null;
  }
  const { property } = callee;
  return property.type === "Identifier" ? property.name : null;
}

function chunkAt(chunks: readonly Chunk[], offset: number): Chunk | undefined {
  let low = 0;
  let high = chunks.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((chunks[middle]?.cookedStart ?? 0) <= offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const chunk = chunks[low - 1];
  return chunk !== undefined && offset < chunk.cookedEnd ? chunk : undefined;
}

function mapping(chunks: readonly Chunk[]): PromptNode["toSource"] {
  return (start, end) => {
    const chunk = chunkAt(chunks, start) ?? chunks.at(-1);
    if (chunk === undefined) {
      return [0, 0];
    }
    return [
      chunk.rawStart + chunk.toRaw(start - chunk.cookedStart),
      chunk.rawStart + chunk.toRaw(end - chunk.cookedStart),
    ];
  };
}

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

function dialectOf(
  dialects: Readonly<Record<string, Dialect>>,
  name: string | null
): Dialect | undefined {
  return name !== null && Object.hasOwn(dialects, name)
    ? dialects[name]
    : undefined;
}

export function promptOf(
  node: Candidate,
  dialects: Readonly<Record<string, Dialect>>,
  text: string
): PromptNode | null {
  if (node.type === "TaggedTemplateExpression") {
    const dialect = dialectOf(dialects, memberName(node.tag));
    return dialect === undefined ? null : fromTemplate(dialect, node.quasi);
  }
  const dialect = dialectOf(dialects, memberName(node.callee));
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
