import type { InputField } from "~/lib/inputs";
import type { MonitorSpec } from "~/lib/monitor";
import type { AnyDefinition } from "./definition";
import { fieldsFromSchema, JSON_INPUT_FIELD, jsonSchemaOf } from "./schema";
import type { Schedule } from "./triggers";

/**
 * What can run and what starts it: named definitions, the schedules that
 * launch them, and the source each monitor watches. An engine owns one and
 * is the only writer of it; a host adds to it through the engine. A
 * definition without a name is internal and never appears here. Schedules
 * and monitors are keyed by what they trigger and watch.
 */

/** A launchable definition, as a host lists it. */
export interface DefinitionEntry {
  readonly description?: string;
  /** The name came from the config's `const`. */
  readonly inferred?: boolean;
  /** Launch-form fields; an empty list means no arguments. */
  readonly input: { readonly fields: readonly InputField[] };
  readonly inputSchema?: Record<string, unknown>;
  readonly kind: "step" | "workflow";
  readonly name: string;
}

/** The detector step agent-created monitors share; never launchable by hand. */
export const AUTOMATION_MONITOR = "__automation_monitor";

function where(definition: AnyDefinition): string {
  const { site } = definition;
  return site ? ` (${site.file}:${String(site.line)})` : "";
}

export class Registry {
  readonly definitions = new Map<string, AnyDefinition>();
  /** Keyed like the detector step and the schedule a monitor registers. */
  readonly monitors = new Map<string, MonitorSpec>();
  readonly schedules = new Map<string, Schedule>();

  define(definition: AnyDefinition): void {
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

  /** The detector step is already defined under `key`. */
  monitor(key: string, spec: MonitorSpec, record: Schedule): void {
    this.schedule(record);
    this.monitors.set(key, spec);
  }

  /** Launchable definitions, without monitor detectors. */
  entries(): readonly DefinitionEntry[] {
    return [...this.definitions.values()]
      .filter(
        (definition) =>
          definition.name !== AUTOMATION_MONITOR &&
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
}
