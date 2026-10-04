import type { InputField } from "~/lib/inputs";
import type { MonitorSpec } from "~/lib/monitor";
import type { AnyDefinition } from "./definition";
import { fieldsFromSchema, JSON_INPUT_FIELD, jsonSchemaOf } from "./schema";
import type { Schedule } from "./triggers";

/**
 * What a host registered. Named definitions are the catalog: the engine
 * launches them by name, as do schedules. A definition without a name is
 * internal and never appears here. Schedules and monitors are keyed by what
 * they trigger and watch. The engine is handed one and reads it; whoever
 * writes the definitions fills it.
 */

export interface CatalogEntry {
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

export class Catalog {
  readonly definitions = new Map<string, AnyDefinition>();
  /** Keyed like the detector step and the schedule a monitor registers. */
  readonly monitors = new Map<string, MonitorSpec>();
  readonly schedules = new Map<string, Schedule>();
  /** Paths of declared workspaces, as written; sandboxes may mount them. */
  readonly workspaces = new Set<string>();
  readonly #counters = new Map<string, number>();

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
      .filter(
        (definition) =>
          definition.name !== "__automation_monitor" &&
          !this.monitors.has(definition.name as string)
      )
      .map((definition) => {
        const schema = definition.input;
        // No schema: no arguments. A schema the library cannot describe as
        // JSON Schema still takes input, as one JSON field.
        const fields = schema
          ? (fieldsFromSchema(schema) ?? [JSON_INPUT_FIELD])
          : [];
        const inputSchema = schema ? jsonSchemaOf(schema) : undefined;
        return {
          ...(definition.description === undefined
            ? {}
            : { description: definition.description }),
          ...(definition.inferred ? { inferred: true } : {}),
          input: { fields },
          ...(inputSchema === undefined ? {} : { inputSchema }),
          kind: definition.kind,
          name: definition.name as string,
        };
      });
  }

  /** Tests only: forget everything a previous config registered. */
  reset(): void {
    this.definitions.clear();
    this.schedules.clear();
    this.monitors.clear();
    this.workspaces.clear();
    this.#counters.clear();
  }
}

/**
 * The default catalog: the one a `quirks.config.ts` fills as it is imported.
 * Nothing in the lib reads it; an engine runs whichever catalog it is handed.
 */
export const catalog = new Catalog();
