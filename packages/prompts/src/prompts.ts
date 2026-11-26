import { Dialect } from "./dialect";
import { claudeCode } from "./dialects/claude-code";
import { codex } from "./dialects/codex";
import { pi } from "./dialects/pi";
import type { Interpolation } from "./interpolate";
import { interpolate } from "./interpolate";
import type { Surface } from "./notation";
import { Parser } from "./parser";
import { Prompt, PromptError } from "./prompt";
import { referenceOf } from "./reference";
import type { PromptSource } from "./source";
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
  | "portable"
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
  portable(
    strings: TemplateStringsArray,
    ...values: Interpolation[]
  ): PortablePrompt;
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
  "portable",
  "remove",
  "strict",
  "surface",
]);

const plain = new Dialect({ id: "direct", label: "Plain text", notations: [] });

export class PortablePrompt {
  readonly key: string;
  readonly text: string;
  readonly render: (harness: string) => Prompt;

  constructor(fields: Pick<PortablePrompt, "key" | "render" | "text">) {
    this.key = fields.key;
    this.text = fields.text;
    this.render = fields.render;
  }
}

export function assemble<D extends Record<string, Dialect>>(
  options: PromptsOptions<D>
): Prompts<D> {
  const layers: PromptSource[] = [];
  const dialects = Object.values(options.dialects);
  const byHarness = new Map<string, Tag>();

  const base: PromptsBase = {
    ...layered(layers),
    add(source) {
      layers.push(isSource(source) ? source : namesSource(source));
      return this;
    },
    portable(strings, ...values) {
      const captured = values.map(
        (value) => referenceOf(value) ?? String(value)
      );
      return new PortablePrompt({
        key: JSON.stringify([strings, captured]),
        render: (harness) =>
          (byHarness.get(harness) ?? plainTag)(strings, ...captured),
        text: interpolate(plain, strings, captured).text,
      });
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
  const plainTag = tag(plain);
  for (const [key, dialect] of Object.entries(options.dialects)) {
    if (RESERVED.has(key)) {
      throw new Error(
        `"${key}" is reserved on prompts; name the dialect something else.`
      );
    }
    const author = tag(dialect);
    tags[key] = author;
    byHarness.set(dialect.id, author);
  }
  for (const source of options.sources ?? []) {
    base.add(source);
  }
  return Object.assign(base, tags) as Prompts<D>;
}

export const prompts = assemble({
  dialects: { claude: claudeCode, codex, pi },
});
