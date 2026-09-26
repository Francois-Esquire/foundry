import type { InputField } from "~/lib/inputs";
import type { MonitorSpec } from "~/monitor";

import type { Bindings } from "./bindings";
import type { AnyDefinition } from "./definition";
import { fieldsFromSchema, jsonSchemaOf } from "./schema";
import type { Schedule } from "./triggers";

/**
 * What the config registered. Named definitions are the catalog: the CLI,
 * the dashboard, and schedules launch them by name. A name is given to the
 * builder or inferred from the top-level `const`; a definition with neither
 * is internal and never appears here. Schedules and monitors are keyed by
 * what they trigger and watch.
 */

interface CatalogEntry {
  readonly description?: string;
  /** The name came from the config's `const`. */
  readonly inferred?: boolean;
  /** Launch-form fields; an empty list means no arguments. */
  readonly input: { readonly fields: readonly InputField[] };
  readonly inputSchema?: Record<string, unknown>;
  readonly kind: "step" | "workflow";
  readonly name: string;
}

function where(definition: AnyDefinition): string {
  const { site } = definition;
  return site ? ` (${site.file}:${String(site.line)})` : "";
}

class Catalog {
  readonly definitions = new Map<string, AnyDefinition>();
  /** Keyed like the detector step and the schedule a monitor registers. */
  readonly monitors = new Map<string, MonitorSpec>();
  readonly schedules = new Map<string, Schedule>();
  /** Paths of declared workspaces, as written; sandboxes may mount them. */
  readonly workspaces = new Set<string>();
  readonly #counters = new Map<string, number>();
  #bindings: Bindings | undefined;

  register(definition: AnyDefinition): void {
    if (definition.name === undefined) {
      return;
    }
    const taken = this.definitions.get(definition.name);
    if (taken) {
      throw new Error(
        `"${definition.name}" already registered${where(taken)}; ${
          definition.inferred || taken.inferred
            ? `the name comes from a const${where(definition)}; rename one or name it explicitly`
            : `second registration${where(definition)}`
        }`
      );
    }
    this.definitions.set(definition.name, definition);
  }

  schedule(record: Schedule): void {
    if (this.schedules.has(record.key)) {
      throw new Error(`schedule "${record.key}" already registered`);
    }
    this.schedules.set(record.key, record);
  }

  /** The detector step is already registered under `key`. */
  monitor(key: string, spec: MonitorSpec, record: Schedule): void {
    this.schedule(record);
    this.monitors.set(key, spec);
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
          ...(definition.inferred ? { inferred: true } : {}),
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
    this.workspaces.clear();
    this.#counters.clear();
    this.#bindings = undefined;
  }
}

export const catalog = new Catalog();
