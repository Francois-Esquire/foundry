import type { Notation } from "./notation";
import type { PromptReference } from "./reference";
import type { PromptSource } from "./source";
import { namesSource, type PromptNames } from "./source";

export interface DialectSpec {
  readonly id: string;
  readonly known?: PromptNames;
  readonly label: string;
  readonly notations: readonly Notation[];
}

export class Dialect {
  readonly builtins: PromptSource;
  readonly id: string;
  readonly known: PromptNames;
  readonly label: string;
  readonly notations: readonly Notation[];
  private readonly byId: ReadonlyMap<string, Notation>;

  constructor(spec: DialectSpec) {
    this.id = spec.id;
    this.label = spec.label;
    this.notations = spec.notations;
    this.known = spec.known ?? {};
    this.builtins = namesSource(this.known);
    this.byId = new Map(spec.notations.map((item) => [item.id, item]));
  }

  notation(id: string): Notation | undefined {
    return this.byId.get(id);
  }

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
