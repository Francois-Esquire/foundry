import { Dialect } from "./dialect";
import { claudeCode } from "./dialects/claude-code";
import { codex } from "./dialects/codex";
import { pi } from "./dialects/pi";
import type { Interpolation } from "./interpolate";
import { interpolate } from "./interpolate";
import type { Surface } from "./notation";
import { Parser } from "./parser";
import { Prompt, PromptError } from "./prompt";
import type { PromptReference } from "./reference";
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
  | "render"
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
  remove(source: PromptSource | PromptNames): boolean;
  render(data: PortablePromptData, harness: string): Prompt;
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
  "render",
  "strict",
  "surface",
]);

const plain = new Dialect({ id: "direct", label: "Plain text", notations: [] });

export type PortablePromptValue = PromptReference | string;

export interface PortablePromptData {
  readonly chunks: readonly string[];
  readonly values: readonly PortablePromptValue[];
}

export class PortablePrompt {
  readonly chunks: readonly string[];
  readonly key: string;
  readonly render: (harness: string) => Prompt;
  readonly text: string;
  readonly values: readonly PortablePromptValue[];

  constructor(
    fields: Pick<PortablePrompt, "key" | "render" | "text"> &
      Partial<Pick<PortablePrompt, "chunks" | "values">>
  ) {
    const chunks = fields.chunks ?? [fields.text];
    const values = fields.values ?? [];
    if (
      (fields.chunks !== undefined || fields.values !== undefined) &&
      (chunks.length === 0 || values.length !== chunks.length - 1)
    ) {
      throw new Error(
        `PortablePrompt requires chunks.length > 0 and values.length === chunks.length - 1 (got ${chunks.length} chunks and ${values.length} values).`
      );
    }
    this.chunks = chunks;
    this.key = fields.key;
    this.render = fields.render;
    this.text = fields.text;
    this.values = values;
  }

  toJSON(): PortablePromptData {
    return {
      chunks: [...this.chunks],
      values: [...this.values],
    };
  }
}

function renderChunks(
  dialect: Dialect,
  siblings: readonly Dialect[],
  sources: PromptSource,
  parser: Parser,
  surface: Surface,
  strict: boolean,
  chunks: readonly string[],
  values: readonly Interpolation[]
): Prompt {
  const { diagnostics, symbols, text } = interpolate(dialect, chunks, values);
  const prompt = new Prompt({
    authoring: diagnostics,
    dialect,
    siblings,
    sources,
    surface,
    symbols,
    text,
    tokens: parser.tokenize(text),
  });
  if (strict) {
    const found = prompt.diagnostics;
    if (found.some((item) => item.severity === "error")) {
      throw new PromptError(prompt, found);
    }
  }
  return prompt;
}

export function assemble<D extends Record<string, Dialect>>(
  options: PromptsOptions<D>
): Prompts<D> {
  const layers: PromptSource[] = [];
  const wrapped = new WeakMap<PromptNames, PromptSource[]>();
  const dialects = Object.values(options.dialects);
  const byHarness = new Map<
    string,
    (chunks: readonly string[], values: readonly Interpolation[]) => Prompt
  >();

  const base: PromptsBase = {
    ...layered(layers),
    add(source) {
      if (isSource(source)) {
        layers.push(source);
      } else {
        const adapted = namesSource(source);
        layers.push(adapted);
        const existing = wrapped.get(source);
        if (existing) {
          existing.push(adapted);
        } else {
          wrapped.set(source, [adapted]);
        }
      }
      return this;
    },
    portable(strings, ...values) {
      const chunks = Array.from(strings);
      const captured: PortablePromptValue[] = values.map(
        (value) => referenceOf(value) ?? String(value)
      );
      const data: PortablePromptData = { chunks, values: captured };
      return new PortablePrompt({
        chunks,
        key: JSON.stringify([chunks, captured]),
        render: (harness) => base.render(data, harness),
        text: interpolate(plain, chunks, captured).text,
        values: captured,
      });
    },
    remove(source) {
      let target: PromptSource | undefined;
      if (isSource(source)) {
        target = source;
      } else {
        const existing = wrapped.get(source);
        target = existing?.shift();
        if (existing && existing.length === 0) {
          wrapped.delete(source);
        }
      }
      if (!target) {
        return false;
      }
      const index = layers.indexOf(target);
      if (index === -1) {
        return false;
      }
      layers.splice(index, 1);
      return true;
    },
    render(data, harness) {
      return (byHarness.get(harness) ?? renderPlain)(data.chunks, data.values);
    },
    strict: options.strict ?? false,
    surface: options.surface ?? "message",
  };

  const makeDialectAuthor = (dialect: Dialect) => {
    const siblings = dialects.filter((item) => item !== dialect);
    const sources = layered([dialect.builtins, base]);
    const parser = new Parser(dialect, sources);
    const render = (
      chunks: readonly string[],
      values: readonly Interpolation[]
    ): Prompt =>
      renderChunks(
        dialect,
        siblings,
        sources,
        parser,
        base.surface,
        base.strict,
        chunks,
        values
      );
    const author = (
      first: TemplateStringsArray | string,
      ...values: Interpolation[]
    ): Prompt => {
      if (typeof first === "string") {
        const prompt = new Prompt({
          authoring: [],
          dialect,
          siblings,
          sources,
          surface: base.surface,
          symbols: [],
          text: first,
          tokens: parser.tokenize(first),
        });
        if (base.strict) {
          const found = prompt.diagnostics;
          if (found.some((item) => item.severity === "error")) {
            throw new PromptError(prompt, found);
          }
        }
        return prompt;
      }
      return render(first, values);
    };
    return {
      render,
      tag: Object.assign(author, { dialect }) as Tag,
    };
  };

  const tags: Record<string, Tag> = {};
  const { render: renderPlain } = makeDialectAuthor(plain);
  for (const [key, dialect] of Object.entries(options.dialects)) {
    if (RESERVED.has(key)) {
      throw new Error(
        `"${key}" is reserved on prompts; name the dialect something else.`
      );
    }
    const { render, tag: author } = makeDialectAuthor(dialect);
    tags[key] = author;
    byHarness.set(dialect.id, render);
  }
  for (const source of options.sources ?? []) {
    base.add(source);
  }
  return Object.assign(base, tags) as Prompts<D>;
}

export const prompts = assemble({
  dialects: { claude: claudeCode, codex, pi },
});
