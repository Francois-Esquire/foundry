import { interpolate } from "./author";
import type { Dialect } from "./dialect";
import { claudeCode } from "./dialects/claude-code";
import { codex } from "./dialects/codex";
import { pi } from "./dialects/pi";
import type { Interpolation, PromptSource, Surface } from "./language";
import { Parser } from "./parser";
import { Prompt, PromptError } from "./prompt";
import { isSource, layered, namesSource, type PromptNames } from "./source";

export interface Tag {
  readonly dialect: Dialect;
  (strings: TemplateStringsArray, ...values: Interpolation[]): Prompt;
  (text: string): Prompt;
}

export type ReservedKey =
  | "add"
  | "covers"
  | "has"
  | "remove"
  | "strict"
  | "surface";

export interface PromptsOptions<D extends Record<string, Dialect>> {
  readonly dialects: D;
  readonly sources?: readonly (PromptSource | PromptNames)[];
  readonly strict?: boolean;
  readonly surface?: Surface;
}

export interface PromptsBase extends PromptSource {
  add(source: PromptSource | PromptNames): this;
  remove(source: PromptSource): boolean;
  strict: boolean;
  readonly surface: Surface;
}

export type Prompts<D extends Record<string, Dialect>> = PromptsBase & {
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

export function assemble<D extends Record<string, Dialect>>(
  options: PromptsOptions<D>
): Prompts<D> {
  const layers: PromptSource[] = [];
  const dialects = Object.values(options.dialects);

  const base: PromptsBase = {
    ...layered(layers),
    add(source) {
      layers.push(isSource(source) ? source : namesSource(source));
      return this;
    },
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
    const siblings = dialects.filter((item) => item !== dialect);
    const sources = layered([dialect.builtins, base]);
    const parser = new Parser(dialect, sources);
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
        siblings,
        sources,
        surface: base.surface,
        symbols,
        text,
        tokens: parser.tokenize(text),
      });
      if (base.strict) {
        const found = prompt.diagnostics;
        if (found.some((item) => item.severity === "error")) {
          throw new PromptError(prompt, found);
        }
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
    tags[key] = tag(dialect);
  }
  for (const source of options.sources ?? []) {
    base.add(source);
  }
  return Object.assign(base, tags) as Prompts<D>;
}

export const prompts = assemble({
  dialects: { claude: claudeCode, codex, pi },
});
