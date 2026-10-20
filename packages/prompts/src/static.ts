import { diagnose } from "./check";
import type { Dialect } from "./dialect";
import { claudeCode } from "./dialects/claude-code";
import { codex } from "./dialects/codex";
import { pi } from "./dialects/pi";
import type { Diagnostic, PromptSource, Surface } from "./language";
import { Parser } from "./parser";
import { isSource, layered, namesSource, type PromptNames } from "./source";

const STOCK: readonly Dialect[] = [claudeCode, codex, pi];

export interface CheckOptions {
  /** What exists, layered over the dialect's built-ins: listed names, predicates, or a source. Nothing by default, so no skill or agent is questioned. */
  readonly sources?: PromptSource | PromptNames;
  /** Where the prompt is read. Defaults to `message`. */
  readonly surface?: Surface;
}

/**
 * Check a template's literal chunks statically, without authoring a
 * prompt: what a linter does with a tagged template it finds in source.
 * The chunks are the template's cooked strings, one per `TemplateElement`,
 * so a `${}` between two of them is a hole no notation spans. Spans are
 * offsets into the chunks joined as written; `cookedToRaw` maps them back
 * to source. The other stock dialects read the same text, so a sigil from
 * the wrong harness is caught when the name is one `sources` has.
 */
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
