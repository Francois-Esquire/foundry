/**
 * Command templates as argument lists, never as shell text. A template is
 * split the way a POSIX shell quotes, without a shell: whitespace separates
 * arguments, single quotes are literal, double quotes keep spaces and allow
 * `\"`, `\\`, and `\$`, and a backslash outside quotes escapes the next
 * character. Nothing is expanded or globbed. `$name` (outside single quotes)
 * is a placeholder: its value fills part or all of one argument and is never
 * split or read by a shell, so a value cannot add an argument or a command.
 */

/** One piece of an argument: text as written, or a placeholder's name. */
export type ArgvSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "placeholder"; readonly name: string };

/** One argument, as the pieces it is made of. */
export type ArgvArgument = readonly ArgvSegment[];

const NAME_START = /[A-Za-z_]/;
const NAME_PART = /[A-Za-z0-9_]/;
const SPACE = /\s/;
const DOUBLE_QUOTE_ESCAPES = new Set(['"', "\\", "$"]);

class Builder {
  readonly args: ArgvSegment[][] = [];
  #current: ArgvSegment[] | undefined;

  /** Start an argument even when it stays empty, as `""` does. */
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

/** The placeholder starting at `start` (just after `$`), or undefined when it is a literal `$`. */
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

/** Reads a template one token at a time; each read returns the next index. */
class Reader {
  readonly out = new Builder();
  quote: Quote | undefined;
  readonly #template: string;

  constructor(template: string) {
    this.#template = template;
  }

  /** Inside single quotes everything is literal until the closing quote. */
  single(index: number): number {
    const char = this.#template[index] as string;
    if (char === "'") {
      this.quote = undefined;
    } else {
      this.out.text(char);
    }
    return index + 1;
  }

  /** A backslash: in double quotes only `"`, `\`, and `$` are escaped. */
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

  /** `$name`, or undefined when the `$` is literal. */
  placeholder(index: number): number | undefined {
    const name = nameAt(this.#template, index + 1);
    if (name === undefined) {
      return;
    }
    this.out.placeholder(name);
    return index + 1 + name.length;
  }

  /** Outside single quotes: quotes open and close, spaces end an argument. */
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

/** Split a template into arguments; throws on an unclosed quote or a trailing backslash. */
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

/** Every placeholder a parsed template names, once each, in order. */
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

/**
 * The argument list a parsed template makes with these values. A
 * placeholder that is a whole argument and holds an array becomes one
 * argument per element; anywhere else a value is one string.
 */
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

/** An argument as a shell would need it written, for showing a command. */
export function shellQuote(arg: string): string {
  if (arg !== "" && SAFE.test(arg)) {
    return arg;
  }
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** A whole argument list, quoted for display. */
export function showArgv(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}
