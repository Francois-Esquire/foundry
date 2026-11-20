import type {
  Reference,
  Referenceable,
  ReferenceSource,
} from "@foundry/core/agents";
import type { Prompt } from "./prompt";

export type ArgumentSelector =
  | { readonly by: "all" }
  | { readonly by: "name"; readonly name: string }
  | { readonly by: "position"; readonly index: number };

export type InvocationKind = "command" | "skill" | "template";

export interface Invoked<K extends InvocationKind> {
  readonly arguments?: string;
  readonly kind: K;
  readonly name: string;
}

export type PromptReference =
  | Exclude<Reference, { kind: "skill" }>
  | Invoked<"command">
  | Invoked<"skill">
  | Invoked<"template">
  | { readonly kind: "argument"; readonly selector: ArgumentSelector }
  | { readonly command: string; readonly kind: "shell" }
  | { readonly kind: "variable"; readonly name: string };

export type PromptReferenceKind = PromptReference["kind"];

export type PromptSource = ReferenceSource<PromptReferenceKind>;

export type Surface = "message" | "template";

export type TokenKind = PromptReferenceKind | "escape" | "hole" | "text";

export interface Span {
  readonly end: number;
  readonly start: number;
}

export interface ReferenceToken {
  readonly kind: PromptReferenceKind;
  readonly notation: string;
  readonly reference: PromptReference;
  readonly span: Span;
  readonly text: string;
}

export interface PlainToken {
  readonly kind: "escape" | "hole" | "text";
  readonly span: Span;
  readonly text: string;
}

export type Token = PlainToken | ReferenceToken;

export type LocatedPromptReference = PromptReference & {
  readonly notation: string;
  readonly origin: "symbol" | "text";
  readonly span: Span;
};

export type DiagnosticCode =
  | "consumed-by-harness"
  | "foreign-notation"
  | "misread-reference"
  | "template-only"
  | "unresolved-reference"
  | "unsupported-reference";

export type DiagnosticSeverity = "error" | "info" | "warning";

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly reference?: PromptReference;
  readonly severity: DiagnosticSeverity;
  readonly span: Span;
}

export interface MatchContext {
  readonly atStart: boolean;
  knows(kind: PromptReferenceKind, name: string): boolean;
}

export interface NotationMatch {
  readonly end: number;
  readonly reference?: PromptReference;
}

export interface Notation {
  readonly consumes: boolean;
  readonly id: string;
  readonly kind: PromptReferenceKind | "escape";
  match(text: string, at: number, context: MatchContext): NotationMatch | null;
  readonly position: "anywhere" | "start";
  readonly surface: Surface;
  write?(reference: PromptReference): string | null;
}

export type Interpolation =
  | Prompt
  | PromptReference
  | Referenceable
  | number
  | string;
