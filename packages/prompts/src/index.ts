export type {
  Reference,
  Referenceable,
  ReferenceKind,
  ReferenceSource,
} from "@foundry/core/agents";
// biome-ignore lint/performance/noBarrelFile: This is the exported @foundry/prompts public API.
export { isReferenceable, REFERENCE } from "@foundry/core/agents";
export type { CheckOptions } from "./check";
export { check } from "./check";
export type {
  Diagnostic,
  DiagnosticCode,
  DiagnosticSeverity,
} from "./diagnose";
export type { DialectSpec } from "./dialect";
export { Dialect } from "./dialect";
export { claudeCode } from "./dialects/claude-code";
export { codex } from "./dialects/codex";
export { pi } from "./dialects/pi";
export { HIGHLIGHT_SCOPES } from "./highlight";
export type { Interpolation } from "./interpolate";
export type {
  AgentMentionSpec,
  EscapeSpec,
  InvocationSpec,
  MatchContext,
  MentionSpec,
  Notation,
  NotationMatch,
  PlaceholderForm,
  PlaceholderSpec,
  ShellSpec,
  Surface,
  VariableSpec,
} from "./notation";
export { notation } from "./notation";
export { cookedToRaw } from "./offsets";
export type { PlainToken, ReferenceToken, Token, TokenKind } from "./parser";
export { Parser } from "./parser";
export { Prompt, PromptError } from "./prompt";
export type {
  PortablePromptData,
  PortablePromptValue,
  Prompts,
  PromptsBase,
  PromptsOptions,
  ReservedKey,
  Tag,
} from "./prompts";
export { assemble, PortablePrompt, prompts } from "./prompts";
export type {
  ArgumentSelector,
  InvocationKind,
  Invoked,
  LocatedPromptReference,
  PromptReference,
  PromptReferenceKind,
} from "./reference";
export { ref, referenceOf } from "./reference";
export type { Membership, PromptNames, PromptSource } from "./source";
export type { Span } from "./spans";
