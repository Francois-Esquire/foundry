import { isReferenceable, REFERENCE } from "@foundry/core/agents";
import type {
  Interpolation,
  InvocationKind,
  Invoked,
  PromptReference,
} from "./language";

/** A reference invoked by name, with its arguments only when there are any. */
export function invoked<K extends InvocationKind>(
  kind: K,
  name: string,
  args?: string
): Invoked<K> {
  return args === undefined ? { kind, name } : { arguments: args, kind, name };
}

/** The name a reference resolves by, or `undefined` for kinds that have none. */
export function nameOf(reference: PromptReference): string | undefined {
  if ("name" in reference) {
    return reference.name;
  }
  return "path" in reference ? reference.path : undefined;
}

/**
 * The reference an interpolated value stands for, or `null` for plain text.
 * A value is a reference when it implements the reference protocol or is
 * plain reference data with a string `kind`; anything else, a `Prompt`
 * included, is inserted as its text.
 */
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

/**
 * Typed references to interpolate into a dialect's template literal. Each is
 * written in the target dialect's own notation, so one prompt renders for
 * every harness: `ref.skill("review")` is `/review` for Claude Code and
 * `$review` for Codex.
 */
export const ref = {
  agent: (name: string): PromptReference => ({ kind: "agent", name }),
  /** No selector: every argument. A number: that position. A string: that named argument. */
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
