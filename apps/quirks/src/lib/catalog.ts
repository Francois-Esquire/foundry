import type { InputField } from "~/lib/inputs";
import type { MonitorSpec } from "~/monitor";

import type { Bindings } from "./bindings";
import type { AnyDefinition } from "./definition";
import { fieldsFromSchema, jsonSchemaOf } from "./schema";
import type { Schedule } from "./triggers";

/**
 * What the config registered. Named definitions are the catalog: the CLI,
 * the dashboard, and schedules launch them by name. Anonymous ones are
 * internal and never appear here. Schedules and monitors keep their names
 * in phase 1.
 */

interface CatalogEntry {
  readonly description?: string;
  /** Launch-form fields; an empty list means no arguments. */
  readonly input: { readonly fields: readonly InputField[] };
  readonly inputSchema?: Record<string, unknown>;
  readonly kind: "step" | "workflow";
  readonly name: string;
}

class Catalog {
  readonly definitions = new Map<string, AnyDefinition>();
  /** Keyed like the step and schedule a monitor registers under the same name. */
  readonly monitors = new Map<string, MonitorSpec>();
  readonly schedules = new Map<string, Schedule>();
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

  schedule(record: Schedule): void {
    if (this.schedules.has(record.name)) {
      throw new Error(`schedule "${record.name}" already registered`);
    }
    this.schedules.set(record.name, record);
  }

  /** The detector step is already registered under `name`. */
  monitor(name: string, spec: MonitorSpec, record: Schedule): void {
    this.schedule(record);
    this.monitors.set(name, spec);
  }

  /** Registration-order ids for nameless resources, e.g. `agent#2`. */
  claimId(kind: string): string {
    const next = (this.#counters.get(kind) ?? 0) + 1;
    this.#counters.set(kind, next);
    return `${kind}#${next}`;
  }

  /** Launchable definitions, without monitor detectors. */
  entries(): readonly CatalogEntry[] {
    return [...this.definitions.values()]
      .filter((definition) => !this.monitors.has(definition.name as string))
      .map((definition) => {
        const schema = definition.input;
        const fields = schema ? fieldsFromSchema(schema) : undefined;
        const inputSchema = schema ? jsonSchemaOf(schema) : undefined;
        return {
          ...(definition.description === undefined
            ? {}
            : { description: definition.description }),
          input: { fields: fields ?? [] },
          ...(inputSchema === undefined ? {} : { inputSchema }),
          kind: definition.kind,
          name: definition.name as string,
        };
      });
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
    this.schedules.clear();
    this.monitors.clear();
    this.#counters.clear();
    this.#bindings = undefined;
  }
}

export const catalog = new Catalog();
