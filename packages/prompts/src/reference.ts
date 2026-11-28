import type { Reference } from "@foundry/core/agents";
import { isReferenceable, REFERENCE } from "@foundry/core/agents";
import type { Interpolation } from "./interpolate";
import type { Span } from "./spans";

export function invoked<K extends InvocationKind>(
  kind: K,
  name: string,
  args?: string
): Invoked<K> {
  return args === undefined ? { kind, name } : { arguments: args, kind, name };
}

export function nameOf(reference: PromptReference): string | undefined {
  if ("name" in reference) {
    return reference.name;
  }
  return "path" in reference ? reference.path : undefined;
}

export function referenceOf(value: Interpolation): PromptReference | null {
  if (isReferenceable(value)) {
    return value[REFERENCE]();
  }
  return isPromptReference(value) ? value : null;
}

function isPromptReference(value: unknown): value is PromptReference {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}

export const ref = {
  agent: (name: string): PromptReference => ({ kind: "agent", name }),
  argument: (selector?: number | string): PromptReference => {
    if (selector === undefined) {
      return { kind: "argument", selector: { by: "all" } };
    }
    if (typeof selector === "number") {
      return {
        kind: "argument",
        selector: { by: "position", index: selector },
      };
    }
    return { kind: "argument", selector: { by: "name", name: selector } };
  },
  command: (name: string, args?: string): PromptReference =>
    invoked("command", name, args),
  file: (path: string): PromptReference => ({ kind: "file", path }),
  shell: (command: string): PromptReference => ({ command, kind: "shell" }),
  skill: (name: string, args?: string): PromptReference =>
    invoked("skill", name, args),
  template: (name: string, args?: string): PromptReference =>
    invoked("template", name, args),
  variable: (name: string): PromptReference => ({ kind: "variable", name }),
} as const;

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

export type LocatedPromptReference = PromptReference & {
  readonly notation: string;
  readonly origin: "symbol" | "text";
  readonly span: Span;
};
