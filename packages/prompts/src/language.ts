/**
 * The language of the prompts package: what a prompt written for a CLI
 * harness is made of. These terms are harness-neutral. Each dialect maps its
 * own notation into them, so a consumer reasons about "a skill reference" or
 * "an argument placeholder" without knowing whether the author wrote
 * `/name`, `$name`, or `/skill:name`. The reference vocabulary itself lives
 * in `@foundry/core/agents`, shared with the things referred to.
 * CONTEXT.md is the glossary.
 */

import type {
  Reference,
  Referenceable,
  ReferenceSource,
} from "@foundry/core/agents";

/** Which invocation argument an `argument` placeholder stands for. */
export type ArgumentSelector =
  | { readonly by: "all" }
  | { readonly by: "name"; readonly name: string }
  | { readonly by: "position"; readonly index: number };

/**
 * What a prompt can point at: every Foundry reference, a skill invocation
 * carrying its arguments, plus the kinds only a prompt has. **Command**: an action the harness performs itself.
 * **Template**: a saved prompt the harness expands. **Argument**: a
 * placeholder filled when a template is expanded. **Variable**: a value the
 * harness provides when it expands a template. **Shell**: a command run in
 * the shell.
 */
export type PromptReference =
  | Exclude<Reference, { kind: "skill" }>
  | {
      readonly arguments?: string;
      readonly kind: "skill";
      readonly name: string;
    }
  | { readonly kind: "argument"; readonly selector: ArgumentSelector }
  | {
      readonly arguments?: string;
      readonly kind: "command";
      readonly name: string;
    }
  | { readonly command: string; readonly kind: "shell" }
  | {
      readonly arguments?: string;
      readonly kind: "template";
      readonly name: string;
    }
  | { readonly kind: "variable"; readonly name: string };

export type PromptReferenceKind = PromptReference["kind"];

/** One layer of what exists, over every kind a prompt can refer to. */
export type PromptSource = ReferenceSource<PromptReferenceKind>;

/**
 * Where a prompt is read. A `message` is sent to the harness as the user's
 * turn. A `template` is a file the harness expands before sending: a
 * `SKILL.md`, a Claude Code command file, a Codex custom prompt, a Pi prompt
 * template. Some notation is only substituted inside a template.
 */
export type Surface = "message" | "template";

/**
 * What the scanner labels: a reference, an escape sequence, plain text, or,
 * when a template is read statically, a hole where an interpolation sits.
 */
export type TokenKind = PromptReferenceKind | "escape" | "hole" | "text";

/** Half-open character range `[start, end)` into the prompt text. */
export interface Span {
  readonly end: number;
  readonly start: number;
}

/**
 * One scanned piece of the prompt. `kind` equals `reference.kind` when a
 * reference is present. A highlighter needs only `kind` and `span`.
 */
export interface Token {
  readonly kind: TokenKind;
  /** Id of the notation that matched; absent on text. */
  readonly notation?: string;
  readonly reference?: PromptReference;
  readonly span: Span;
  readonly text: string;
}

/**
 * A reference with where it was written, and how: `text` when the author
 * wrote the notation, `symbol` when it was interpolated as a value.
 */
export type LocatedPromptReference = PromptReference & {
  readonly notation: string;
  readonly origin: "symbol" | "text";
  readonly span: Span;
};

export type DiagnosticCode =
  /** The harness consumes this message itself; the model never sees it. */
  | "consumed-by-harness"
  /** A skill or agent the host has, written in another dialect's notation. */
  | "foreign-notation"
  /** Notation that is only substituted inside a template, found in a message. */
  | "template-only"
  /** A reference whose name no prompt source and no built-in has. */
  | "unresolved-reference"
  /** An interpolated reference the dialect has no notation for; written as plain text. */
  | "unsupported-reference";

export type DiagnosticSeverity = "error" | "info" | "warning";

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly reference?: PromptReference;
  readonly severity: DiagnosticSeverity;
  readonly span: Span;
}

/** What the scanner tells a notation about the position it is probing. */
export interface MatchContext {
  /** `at` is the first non-blank character of the message. */
  readonly atStart: boolean;
  /** Whether the harness itself knows this name: a built-in command, a provided variable. */
  knows(kind: PromptReferenceKind, name: string): boolean;
}

export interface NotationMatch {
  readonly end: number;
  readonly reference?: PromptReference;
}

/**
 * One lexical construct a harness recognizes: a sigil, what may follow it,
 * and the reference it denotes. A dialect is an ordered list of these; the
 * first notation that matches at a position wins, so order is precedence.
 */
export interface Notation {
  /** The harness acts on the whole message itself instead of sending it. */
  readonly consumes: boolean;
  readonly id: string;
  readonly kind: TokenKind;
  match(text: string, at: number, context: MatchContext): NotationMatch | null;
  /** `start`: only recognized as the first thing in the message. */
  readonly position: "anywhere" | "start";
  /** Where the harness substitutes it. `message` notation is also live in a template. */
  readonly surface: Surface;
  /** Write a reference in this notation, or `null` when it cannot express it. */
  write?(reference: PromptReference): string | null;
}

/** A value interpolated into a dialect tag. */
export type Interpolation = PromptReference | Referenceable | number | string;
