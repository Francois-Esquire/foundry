import type { Notation, PromptReference, PromptSource } from "./language";
import { namesSource, type PromptNames } from "./source";

export interface DialectSpec {
  /** The harness id the rest of the system routes on: `claude-code`, `codex`, `pi`. */
  readonly id: string;
  /** Names the harness knows without any prompt source: built-in commands, provided variables. */
  readonly known?: PromptNames;
  readonly label: string;
  /** In precedence order: the first notation that matches at a position wins. */
  readonly notations: readonly Notation[];
}

/**
 * One harness's grammar. A value: it reads no text and knows nothing of what exists.
 * It can write a reference in its own notation.
 */
export class Dialect {
  /** What the harness itself knows, as a prompt source. */
  readonly builtins: PromptSource;
  readonly id: string;
  readonly label: string;
  readonly notations: readonly Notation[];
  private readonly byId: ReadonlyMap<string, Notation>;

  constructor(spec: DialectSpec) {
    this.id = spec.id;
    this.label = spec.label;
    this.notations = spec.notations;
    this.builtins = namesSource(spec.known ?? {});
    this.byId = new Map(spec.notations.map((item) => [item.id, item]));
  }

  notation(id: string): Notation | undefined {
    return this.byId.get(id);
  }

  /** Write a reference the way this harness reads it, or `null` when it has no notation for the kind. */
  write(reference: PromptReference): string | null {
    for (const item of this.notations) {
      const written = item.write?.(reference);
      if (written !== null && written !== undefined) {
        return written;
      }
    }
    return null;
  }
}
