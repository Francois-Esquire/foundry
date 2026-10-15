/**
 * `@foundry/prompts`: prompts written for a CLI harness. `prompts` is one
 * flat object: a tag per dialect (`prompts.claude\`…\``) and the utilities
 * that say what exists (`prompts.add(source)`). A tag returns a `Prompt`
 * whose diagnostics are read against what exists each time; a strict
 * `prompts` throws instead. `assemble` builds the same shape from named
 * dialects. The reference vocabulary comes from `@foundry/core/agents`. No
 * Node imports, so an editor extension can load it.
 */

export type {
  Reference,
  Referenceable,
  ReferenceKind,
  ReferenceSource,
} from "@foundry/core/agents";
// biome-ignore lint/performance/noBarrelFile: This is the exported @foundry/prompts public API.
export { isReferenceable, REFERENCE } from "@foundry/core/agents";
export type { DialectSpec } from "./dialect";
export { Dialect } from "./dialect";
export { claudeCode } from "./dialects/claude-code";
export { codex } from "./dialects/codex";
export { pi } from "./dialects/pi";
export { HIGHLIGHT_SCOPES } from "./highlight";
export type {
  ArgumentSelector,
  Diagnostic,
  DiagnosticCode,
  DiagnosticSeverity,
  Interpolation,
  LocatedPromptReference,
  MatchContext,
  Notation,
  NotationMatch,
  PromptReference,
  PromptReferenceKind,
  PromptSource,
  Span,
  Surface,
  Token,
  TokenKind,
} from "./language";
export type {
  AgentMentionSpec,
  EscapeSpec,
  InvocationKind,
  InvocationSpec,
  MentionSpec,
  PlaceholderForm,
  PlaceholderSpec,
  ShellSpec,
  VariableSpec,
} from "./notation";
export { notation } from "./notation";
export { cookedToRaw } from "./offsets";
export { Parser } from "./parser";
export type { PromptFields, SiblingReading } from "./prompt";
export { Prompt, PromptError } from "./prompt";
export type {
  DialectMap,
  Prompts,
  PromptsBase,
  PromptsOptions,
  ReservedKey,
  Tag,
} from "./prompts";
export { assemble, prompts } from "./prompts";
export { ref, referenceOf } from "./reference";
export type { Membership, PromptNames } from "./source";
