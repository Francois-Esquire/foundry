type ArgvSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "placeholder"; readonly name: string };

export type ArgvArgument = readonly ArgvSegment[];

const NAME_START = /[A-Za-z_]/;
const NAME_PART = /[A-Za-z0-9_]/;
const SPACE = /\s/;
const DOUBLE_QUOTE_ESCAPES = new Set(['"', "\\", "$"]);

class Builder {
  readonly args: ArgvSegment[][] = [];
  #current: ArgvSegment[] | undefined;

  touch(): void {
    this.#current ??= [];
  }

  text(char: string): void {
    this.touch();
    const current = this.#current as ArgvSegment[];
    const last = current.at(-1);
    if (last?.kind === "text") {
      current[current.length - 1] = { kind: "text", text: last.text + char };
    } else {
      current.push({ kind: "text", text: char });
    }
  }

  placeholder(name: string): void {
    this.touch();
    this.#current?.push({ kind: "placeholder", name });
  }

  end(): void {
    if (this.#current) {
      this.args.push(this.#current);
      this.#current = undefined;
    }
  }
}

function nameAt(template: string, start: number): string | undefined {
  if (!NAME_START.test(template[start] ?? "")) {
    return;
  }
  let end = start + 1;
  while (NAME_PART.test(template[end] ?? "")) {
    end += 1;
  }
  return template.slice(start, end);
}

type Quote = "'" | '"';

class Reader {
  readonly out = new Builder();
  quote: Quote | undefined;
  readonly #template: string;

  constructor(template: string) {
    this.#template = template;
  }

  single(index: number): number {
    const char = this.#template[index] as string;
    if (char === "'") {
      this.quote = undefined;
    } else {
      this.out.text(char);
    }
    return index + 1;
  }

  escape(index: number): number {
    const next = this.#template[index + 1];
    if (next === undefined) {
      throw new Error(`"${this.#template}" ends with a backslash`);
    }
    if (this.quote === '"' && !DOUBLE_QUOTE_ESCAPES.has(next)) {
      this.out.text("\\");
    }
    this.out.text(next);
    return index + 2;
  }

  placeholder(index: number): number | undefined {
    const name = nameAt(this.#template, index + 1);
    if (name === undefined) {
      return;
    }
    this.out.placeholder(name);
    return index + 1 + name.length;
  }

  plain(index: number): number {
    const char = this.#template[index] as string;
    if (this.quote === '"') {
      if (char === '"') {
        this.quote = undefined;
      } else {
        this.out.text(char);
      }
    } else if (char === "'" || char === '"') {
      this.quote = char;
      this.out.touch();
    } else if (SPACE.test(char)) {
      this.out.end();
    } else {
      this.out.text(char);
    }
    return index + 1;
  }

  next(index: number): number {
    if (this.quote === "'") {
      return this.single(index);
    }
    const char = this.#template[index];
    if (char === "\\") {
      return this.escape(index);
    }
    return (char === "$" && this.placeholder(index)) || this.plain(index);
  }
}

export function parseArgv(template: string): ArgvArgument[] {
  const reader = new Reader(template);
  let index = 0;
  while (index < template.length) {
    index = reader.next(index);
  }
  if (reader.quote) {
    throw new Error(`"${template}" has an unclosed ${reader.quote}`);
  }
  reader.out.end();
  return reader.out.args;
}

export function placeholdersOf(args: readonly ArgvArgument[]): string[] {
  const names = args.flatMap((arg) =>
    arg.flatMap((segment) =>
      segment.kind === "placeholder" ? [segment.name] : []
    )
  );
  return [...new Set(names)];
}

function scalar(name: string, value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  throw new Error(
    `$${name} must be a string, number, or boolean, not ${value === null ? "null" : typeof value}`
  );
}

export function fillArgv(
  args: readonly ArgvArgument[],
  values: Readonly<Record<string, unknown>>
): string[] {
  const lookup = (name: string) => {
    if (!(name in values) || values[name] === undefined) {
      throw new Error(`$${name} has no value`);
    }
    return values[name];
  };
  return args.flatMap((arg) => {
    const [only] = arg;
    if (arg.length === 1 && only?.kind === "placeholder") {
      const value = lookup(only.name);
      return Array.isArray(value)
        ? value.map((item) => scalar(only.name, item))
        : [scalar(only.name, value)];
    }
    return [
      arg
        .map((segment) =>
          segment.kind === "text"
            ? segment.text
            : scalar(segment.name, lookup(segment.name))
        )
        .join(""),
    ];
  });
}

const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function shellQuote(arg: string): string {
  if (arg !== "" && SAFE.test(arg)) {
    return arg;
  }
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

export function showArgv(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}
