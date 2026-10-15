import { interpolate } from "./author";
import type { Dialect } from "./dialect";
import { claudeCode } from "./dialects/claude-code";
import { codex } from "./dialects/codex";
import { pi } from "./dialects/pi";
import type {
  Interpolation,
  PromptReferenceKind,
  PromptSource,
  Surface,
} from "./language";
import { Parser } from "./parser";
import { Prompt, PromptError } from "./prompt";
import { isSource, namesSource, type PromptNames } from "./source";

/** Authors a prompt in one dialect: as a template tag, or from plain text. */
export interface Tag {
  readonly dialect: Dialect;
  (strings: TemplateStringsArray, ...values: Interpolation[]): Prompt;
  (text: string): Prompt;
}

/** The keys every `Prompts` has, so a dialect cannot be named after one. */
export type ReservedKey =
  | "add"
  | "covers"
  | "has"
  | "remove"
  | "strict"
  | "surface";

/** Dialects by the key they will be reached through: `{ claude: claudeCode }` gives `prompts.claude`. */
export type DialectMap = Record<string, Dialect> & {
  readonly [K in ReservedKey]?: never;
};

export interface PromptsOptions<D extends DialectMap> {
  readonly dialects: D;
  /** What exists, as layers: listed names, predicates, or sources such as `promptSource(registries)`. */
  readonly sources?: readonly (PromptSource | PromptNames)[];
  /** Throw from the tag when anything referenced is not present. Defaults to off. */
  readonly strict?: boolean;
  /** Where prompts authored here are read. Defaults to `message`, what an agent turn sends. */
  readonly surface?: Surface;
}

/** The utilities on every `Prompts`, beside its dialect tags. */
export interface PromptsBase extends PromptSource {
  /**
   * Layer in what exists. It counts at once: a prompt authored earlier sees
   * it on its next read, which is how a host defines skills and agents
   * after the prompts that mention them.
   */
  add(source: PromptSource | PromptNames): this;
  /** Take a source back out, by identity; `true` when it was there. Names added as a record cannot be removed. */
  remove(source: PromptSource): boolean;
  /** When on, authoring throws a `PromptError` instead of returning a prompt with errors. */
  strict: boolean;
  readonly surface: Surface;
}

/** One flat object: a tag per dialect, and the utilities, all at depth one. */
export type Prompts<D extends DialectMap> = PromptsBase & {
  readonly [K in keyof D]: Tag;
};

const RESERVED: ReadonlySet<string> = new Set<ReservedKey>([
  "add",
  "covers",
  "has",
  "remove",
  "strict",
  "surface",
]);

/**
 * Assemble a `Prompts` from named dialects and what exists. The names
 * become the keys: `assemble({ dialects: { custom } })` gives
 * `prompts.custom\`…\``. The out-of-the-box `prompts` is this with the three
 * built-in dialects and no sources.
 */
export function assemble<D extends DialectMap>(
  options: PromptsOptions<D>
): Prompts<D> {
  const layers: PromptSource[] = [];
  const dialects = Object.values(options.dialects) as Dialect[];
  const parsers = new Map(dialects.map((item) => [item.id, new Parser(item)]));

  const base: PromptsBase = {
    add(source) {
      layers.push(isSource(source) ? source : namesSource(source));
      return this;
    },
    covers: (kind: PromptReferenceKind) =>
      layers.some((layer) => layer.covers(kind)),
    has: (kind: PromptReferenceKind, name: string) =>
      layers.some((layer) => layer.has(kind, name)),
    remove(source) {
      const index = layers.indexOf(source);
      if (index === -1) {
        return false;
      }
      layers.splice(index, 1);
      return true;
    },
    strict: options.strict ?? false,
    surface: options.surface ?? "message",
  };

  const tag = (dialect: Dialect): Tag => {
    const parser = parsers.get(dialect.id) ?? new Parser(dialect);
    const siblings = dialects.filter((item) => item !== dialect);
    const author = (
      first: TemplateStringsArray | string,
      ...values: Interpolation[]
    ): Prompt => {
      const { diagnostics, symbols, text } =
        typeof first === "string"
          ? { diagnostics: [], symbols: [], text: first }
          : interpolate(dialect, first, values);
      const prompt = new Prompt({
        authoring: diagnostics,
        dialect,
        siblings: siblings.map((item) => ({
          dialect: item,
          tokens: parsers.get(item.id)?.tokenize(text) ?? [],
        })),
        sources: base,
        surface: base.surface,
        symbols,
        text,
        tokens: parser.tokenize(text),
      });
      if (base.strict && !prompt.ok) {
        throw new PromptError(prompt);
      }
      return prompt;
    };
    return Object.assign(author, { dialect });
  };

  const tags: Record<string, Tag> = {};
  for (const [key, dialect] of Object.entries(options.dialects)) {
    if (RESERVED.has(key)) {
      throw new Error(
        `"${key}" is reserved on prompts; name the dialect something else.`
      );
    }
    if (dialect !== undefined) {
      tags[key] = tag(dialect);
    }
  }
  for (const source of options.sources ?? []) {
    base.add(source);
  }
  return Object.assign(base, tags) as Prompts<D>;
}

/** Out of the box: Claude Code, Codex, and Pi, with no sources yet. Configure it with `add`. */
export const prompts = assemble({
  dialects: { claude: claudeCode, codex, pi },
});
