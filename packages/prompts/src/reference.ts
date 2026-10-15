import { isReferenceable, REFERENCE } from "@foundry/core/agents";
import type { Interpolation, PromptReference } from "./language";

function withArguments<K extends "command" | "skill" | "template">(
  kind: K,
  name: string,
  args: string | undefined
): Extract<PromptReference, { kind: K }> {
  const fields =
    args === undefined ? { kind, name } : { arguments: args, kind, name };
  return fields as Extract<PromptReference, { kind: K }>;
}

/** The reference an interpolated value stands for, or `null` for plain text. */
export function referenceOf(value: Interpolation): PromptReference | null {
  if (typeof value === "string" || typeof value === "number") {
    return null;
  }
  return isReferenceable(value) ? value[REFERENCE]() : value;
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
    withArguments("command", name, args),
  file: (path: string): PromptReference => ({ kind: "file", path }),
  shell: (command: string): PromptReference => ({ command, kind: "shell" }),
  skill: (name: string, args?: string): PromptReference =>
    withArguments("skill", name, args),
  template: (name: string, args?: string): PromptReference =>
    withArguments("template", name, args),
  variable: (name: string): PromptReference => ({ kind: "variable", name }),
} as const;
