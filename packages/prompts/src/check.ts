import type { Diagnostic } from "./diagnose";
import { diagnose } from "./diagnose";
import type { Dialect } from "./dialect";
import { claudeCode } from "./dialects/claude-code";
import { codex } from "./dialects/codex";
import { pi } from "./dialects/pi";
import type { Surface } from "./notation";
import { Parser } from "./parser";
import type { PromptSource } from "./source";
import { isSource, layered, namesSource, type PromptNames } from "./source";

const STOCK: readonly Dialect[] = [claudeCode, codex, pi];

export interface CheckOptions {
  readonly sources?: PromptSource | PromptNames;
  readonly surface?: Surface;
}

export function check(
  dialect: Dialect,
  chunks: readonly string[],
  options: CheckOptions = {}
): Diagnostic[] {
  const layers = [dialect.builtins];
  if (options.sources !== undefined) {
    layers.push(
      isSource(options.sources) ? options.sources : namesSource(options.sources)
    );
  }
  const sources = layered(layers);
  const tokens = new Parser(dialect, sources).tokenizeTemplate(chunks);
  const siblings = new Map(
    STOCK.filter((item) => item !== dialect).map((sibling) => [
      sibling,
      new Parser(sibling).tokenizeTemplate(chunks),
    ])
  );
  const found = diagnose(tokens, {
    dialect,
    siblings,
    sources,
    surface: options.surface ?? "message",
  });
  return found.sort((a, b) => a.span.start - b.span.start);
}
