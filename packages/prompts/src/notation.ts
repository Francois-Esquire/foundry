/**
 * The notation builders: the "mini syntaxes" a dialect is composed from. Each
 * builder is one lexical shape parameterized by sigil, kind, and position, so
 * Claude Code's `/name`, Codex's `$name`, and Pi's `/skill:name` are three
 * instances of one builder, not three parsers.
 *
 * Every sigil must sit at a boundary: the start of the text, or after
 * whitespace or an opening bracket or quote. That is how the harnesses read
 * them too, and it keeps `user@host`, `US$5`, and `a/b` out of the result.
 */

import type {
  ArgumentSelector,
  InvocationKind,
  Notation,
  NotationMatch,
} from "./language";
import { invoked } from "./reference";

const BOUNDARY_BEFORE = /[\s([{<"',;]/;
const NAME_SEGMENT = "[A-Za-z0-9](?:[\\w-]*[A-Za-z0-9])?";
const NAME = new RegExp(`${NAME_SEGMENT}(?::${NAME_SEGMENT})*`, "y");
const PATH = /\S+/y;
const TRAILING_PUNCTUATION: ReadonlySet<string> = new Set(".,;:!?)]}>\"'");
const QUOTED_AGENT = /"([^"\n]+?) \(agent\)"/y;
const VARIABLE_NAME = /[A-Za-z_][\w]*/y;
const SHELL_COMMAND = /[^\n]+/y;

const ARGUMENTS_ALL = /ARGUMENTS(?![\w[])/y;
const ARGUMENTS_INDEXED = /ARGUMENTS\[(\d+)\]/y;
const ARGUMENTS_REST = /@/y;
const ARGUMENTS_POSITIONAL = /(\d+)(?!\w)/y;
const ARGUMENTS_NAMED_UPPER = /([A-Z][A-Z0-9_]*)(?![\w-])/y;
const ARGUMENTS_NAMED = /([a-z][\w-]*)(?![\w-])/y;

function execAt(
  pattern: RegExp,
  text: string,
  at: number
): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(text);
}

function atBoundary(text: string, at: number): boolean {
  return at === 0 || BOUNDARY_BEFORE.test(text.charAt(at - 1));
}

/** The path without its trailing sentence punctuation. One pass from the end, so a long run of punctuation costs its length. */
function withoutTrailingPunctuation(path: string): string {
  let end = path.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(path.charAt(end - 1))) {
    end -= 1;
  }
  return path.slice(0, end);
}

/** The rest of the current line, trimmed; `undefined` when blank. */
function restOfLine(text: string, from: number): string | undefined {
  const newline = text.indexOf("\n", from);
  const rest = (
    newline === -1 ? text.slice(from) : text.slice(from, newline)
  ).trim();
  return rest.length > 0 ? rest : undefined;
}

export interface InvocationSpec {
  readonly id: string;
  readonly kind: InvocationKind;
  /** Match only names the harness itself knows (built-in commands). */
  readonly known?: boolean;
  readonly position?: Notation["position"];
  /** What precedes the name: `/`, `$`, `/skill:`, `/prompts:`. */
  readonly sigil: string;
}

/**
 * `<sigil><name> [arguments…]`: a skill, template, or command invoked by
 * name. Names are `[\w-]` segments, optionally namespaced with `:`
 * (`plugin:skill`). A name followed by `/` is a path, not an invocation.
 * Arguments are the rest of the first line when the invocation opens the
 * message.
 */
function invocation(spec: InvocationSpec): Notation {
  const { sigil } = spec;
  return {
    consumes: spec.kind === "command",
    id: spec.id,
    kind: spec.kind,
    match(text, at, context) {
      if (!(text.startsWith(sigil, at) && atBoundary(text, at))) {
        return null;
      }
      const matched = execAt(NAME, text, at + sigil.length);
      if (matched === null) {
        return null;
      }
      const [name] = matched;
      const end = matched.index + name.length;
      if (text.charAt(end) === "/") {
        return null;
      }
      if (spec.known && !context.knows(spec.kind, name)) {
        return null;
      }
      const args = context.atStart ? restOfLine(text, end) : undefined;
      return { end, reference: invoked(spec.kind, name, args) };
    },
    position: spec.position ?? "anywhere",
    surface: "message",
    write(reference) {
      if (reference.kind !== spec.kind) {
        return null;
      }
      const suffix =
        reference.arguments === undefined ? "" : ` ${reference.arguments}`;
      return `${sigil}${reference.name}${suffix}`;
    },
  };
}

export interface MentionSpec {
  readonly id: string;
  /** Defaults to `@`. */
  readonly sigil?: string;
}

/** `@path`: a file or folder mention. Trailing sentence punctuation is not part of the path. */
function mention(spec: MentionSpec): Notation {
  const sigil = spec.sigil ?? "@";
  return {
    consumes: false,
    id: spec.id,
    kind: "file",
    match(text, at) {
      if (!(text.startsWith(sigil, at) && atBoundary(text, at))) {
        return null;
      }
      const matched = execAt(PATH, text, at + sigil.length);
      if (matched === null) {
        return null;
      }
      const path = withoutTrailingPunctuation(matched[0]);
      if (path.length === 0) {
        return null;
      }
      return {
        end: at + sigil.length + path.length,
        reference: { kind: "file", path },
      };
    },
    position: "anywhere",
    surface: "message",
    write(reference) {
      return reference.kind === "file" ? `${sigil}${reference.path}` : null;
    },
  };
}

export interface AgentMentionSpec {
  readonly id: string;
}

/** `@"name (agent)"`: Claude Code's explicit subagent mention. */
function agentMention(spec: AgentMentionSpec): Notation {
  return {
    consumes: false,
    id: spec.id,
    kind: "agent",
    match(text, at) {
      if (!(text.charAt(at) === "@" && atBoundary(text, at))) {
        return null;
      }
      const matched = execAt(QUOTED_AGENT, text, at + 1);
      const name = matched?.[1];
      if (matched === null || name === undefined) {
        return null;
      }
      return {
        end: at + 1 + matched[0].length,
        reference: { kind: "agent", name },
      };
    },
    position: "anywhere",
    surface: "message",
    write(reference) {
      return reference.kind === "agent" ? `@"${reference.name} (agent)"` : null;
    },
  };
}

/**
 * The written forms of an argument placeholder, in match precedence:
 * `$ARGUMENTS`, `$ARGUMENTS[N]`, `$@`, `$N`, `$NAME`, `$name`.
 */
export type PlaceholderForm =
  | "all"
  | "indexed"
  | "named"
  | "named-upper"
  | "positional"
  | "rest";

export interface PlaceholderSpec {
  readonly forms: readonly PlaceholderForm[];
  readonly id: string;
}

interface PlaceholderRule {
  readonly form: PlaceholderForm;
  readonly pattern: RegExp;
  select(matched: RegExpExecArray): ArgumentSelector | null;
}

const PLACEHOLDER_RULES: readonly PlaceholderRule[] = [
  { form: "all", pattern: ARGUMENTS_ALL, select: () => ({ by: "all" }) },
  {
    form: "indexed",
    pattern: ARGUMENTS_INDEXED,
    select: (matched) => positional(matched[1]),
  },
  { form: "rest", pattern: ARGUMENTS_REST, select: () => ({ by: "all" }) },
  {
    form: "positional",
    pattern: ARGUMENTS_POSITIONAL,
    select: (matched) => positional(matched[1]),
  },
  {
    form: "named-upper",
    pattern: ARGUMENTS_NAMED_UPPER,
    select: (matched) => named(matched[1]),
  },
  {
    form: "named",
    pattern: ARGUMENTS_NAMED,
    select: (matched) => named(matched[1]),
  },
];

function positional(digits: string | undefined): ArgumentSelector | null {
  return digits === undefined
    ? null
    : { by: "position", index: Number.parseInt(digits, 10) };
}

function named(name: string | undefined): ArgumentSelector | null {
  return name === undefined ? null : { by: "name", name };
}

function renderSelector(
  selector: ArgumentSelector,
  forms: ReadonlySet<PlaceholderForm>
): string | null {
  switch (selector.by) {
    case "all":
      if (forms.has("all")) {
        return "$ARGUMENTS";
      }
      return forms.has("rest") ? "$@" : null;
    case "position":
      if (forms.has("positional")) {
        return `$${selector.index}`;
      }
      return forms.has("indexed") ? `$ARGUMENTS[${selector.index}]` : null;
    case "name":
      return forms.has("named") || forms.has("named-upper")
        ? `$${selector.name}`
        : null;
    default:
      return null;
  }
}

/** `$…`: a placeholder the harness fills from the invocation's arguments when it expands a template. */
function placeholder(spec: PlaceholderSpec): Notation {
  const forms = new Set(spec.forms);
  const rules = PLACEHOLDER_RULES.filter((rule) => forms.has(rule.form));
  return {
    consumes: false,
    id: spec.id,
    kind: "argument",
    match(text, at) {
      if (!(text.charAt(at) === "$" && atBoundary(text, at))) {
        return null;
      }
      for (const rule of rules) {
        const matched = execAt(rule.pattern, text, at + 1);
        const selector = matched === null ? null : rule.select(matched);
        if (matched !== null && selector !== null) {
          return {
            end: at + 1 + matched[0].length,
            reference: { kind: "argument", selector },
          };
        }
      }
      return null;
    },
    position: "anywhere",
    surface: "template",
    write(reference) {
      return reference.kind === "argument"
        ? renderSelector(reference.selector, forms)
        : null;
    },
  };
}

export interface VariableSpec {
  readonly id: string;
}

/** `${NAME}`: a value the harness provides when it expands a template. */
function variable(spec: VariableSpec): Notation {
  const open = "${";
  return {
    consumes: false,
    id: spec.id,
    kind: "variable",
    match(text, at) {
      if (!text.startsWith(open, at)) {
        return null;
      }
      const matched = execAt(VARIABLE_NAME, text, at + open.length);
      if (matched === null) {
        return null;
      }
      const end = at + open.length + matched[0].length;
      if (text.charAt(end) !== "}") {
        return null;
      }
      return {
        end: end + 1,
        reference: { kind: "variable", name: matched[0] },
      };
    },
    position: "anywhere",
    surface: "template",
    write(reference) {
      return reference.kind === "variable" ? `\${${reference.name}}` : null;
    },
  };
}

export interface ShellSpec {
  readonly id: string;
}

/** `` !`command` ``: output injected into a template before it is sent. */
function inlineShell(spec: ShellSpec): Notation {
  const open = "!`";
  return {
    consumes: false,
    id: spec.id,
    kind: "shell",
    match(text, at) {
      if (!(text.startsWith(open, at) && atBoundary(text, at))) {
        return null;
      }
      const close = text.indexOf("`", at + open.length);
      if (close === -1) {
        return null;
      }
      // Only the body is searched for a newline, so a marker that fails to
      // close costs the distance to the next backtick, not the rest of the text.
      const body = text.slice(at + open.length, close);
      if (body.includes("\n")) {
        return null;
      }
      const command = body.trim();
      if (command.length === 0) {
        return null;
      }
      return { end: close + 1, reference: { command, kind: "shell" } };
    },
    position: "anywhere",
    surface: "template",
    write(reference) {
      return reference.kind === "shell" ? `!\`${reference.command}\`` : null;
    },
  };
}

/** `!command` as the whole message: the harness runs it in the shell instead of sending it. */
function shellLine(spec: ShellSpec): Notation {
  return {
    consumes: true,
    id: spec.id,
    kind: "shell",
    match(text, at) {
      if (text.charAt(at) !== "!" || text.charAt(at + 1) === "`") {
        return null;
      }
      const matched = execAt(SHELL_COMMAND, text, at + 1);
      const command = matched?.[0].trim() ?? "";
      if (matched === null || command.length === 0) {
        return null;
      }
      return {
        end: at + 1 + matched[0].length,
        reference: { command, kind: "shell" },
      };
    },
    position: "start",
    surface: "message",
    write(reference) {
      return reference.kind === "shell" ? `!${reference.command}` : null;
    },
  };
}

export interface EscapeSpec {
  readonly id: string;
  /** The written sequence, such as `$$`. */
  readonly sequence: string;
}

/** A sequence the harness turns into a literal character. Tokenized so it is never read as a sigil. */
function escapeSequence(spec: EscapeSpec): Notation {
  return {
    consumes: false,
    id: spec.id,
    kind: "escape",
    match(text, at): NotationMatch | null {
      return text.startsWith(spec.sequence, at)
        ? { end: at + spec.sequence.length }
        : null;
    },
    position: "anywhere",
    surface: "message",
  };
}

/** The builders a dialect is composed from. */
export const notation = {
  agentMention,
  escape: escapeSequence,
  inlineShell,
  invocation,
  mention,
  placeholder,
  shellLine,
  variable,
} as const;
