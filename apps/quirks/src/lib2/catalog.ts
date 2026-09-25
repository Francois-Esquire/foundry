import type { InputField } from "~/lib/inputs";
import type { Bindings } from "./bindings";
import type { AnyDefinition } from "./definition";
import { fieldsFromSchema, jsonSchemaOf } from "./schema";

/**
 * What the config registered. Named definitions are the catalog: the CLI,
 * the dashboard, and schedules launch them by name. Anonymous ones are
 * internal and never appear here.
 */

export interface CatalogEntry {
  readonly description?: string;
  readonly fields?: readonly InputField[];
  readonly inputSchema?: Record<string, unknown>;
  readonly kind: "step" | "workflow";
  readonly name: string;
}

class Catalog {
  readonly definitions = new Map<string, AnyDefinition>();
  readonly #counters = new Map<string, number>();
  #bindings: Bindings | undefined;

  register(definition: AnyDefinition): void {
    if (definition.name === undefined) {
      return;
    }
    if (this.definitions.has(definition.name)) {
      throw new Error(`"${definition.name}" already registered`);
    }
    this.definitions.set(definition.name, definition);
  }

  /** Registration-order ids for nameless resources, e.g. `agent#2`. */
  claimId(kind: string): string {
    const next = (this.#counters.get(kind) ?? 0) + 1;
    this.#counters.set(kind, next);
    return `${kind}#${next}`;
  }

  entries(): readonly CatalogEntry[] {
    return [...this.definitions.values()].map((definition) => ({
      ...(definition.description === undefined
        ? {}
        : { description: definition.description }),
      ...(definition.input === undefined
        ? {}
        : {
            fields: fieldsFromSchema(definition.input),
            inputSchema: jsonSchemaOf(definition.input),
          }),
      kind: definition.kind,
      name: definition.name as string,
    }));
  }

  bind(bindings: Bindings): void {
    this.#bindings = bindings;
  }

  bindings(): Bindings {
    if (!this.#bindings) {
      throw new Error("the runtime is not bound; the CLI binds it");
    }
    return this.#bindings;
  }

  /** Tests only: forget everything a previous config registered. */
  reset(): void {
    this.definitions.clear();
    this.#counters.clear();
    this.#bindings = undefined;
  }
}

export const catalog = new Catalog();
