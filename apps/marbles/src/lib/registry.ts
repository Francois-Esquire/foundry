import type { InputField } from "~/lib/inputs";
import type { Detector, MonitorHandler, MonitorSpec } from "~/lib/monitor";
import { detector } from "~/lib/monitor";
import type { AnyDefinition, NamedDefinition } from "./definition";
import { isNamed, quoteOrigin } from "./definition";
import { fieldsFromSchema, JSON_INPUT_FIELD, jsonSchemaOf } from "./schema";
import type { Schedule, Trigger } from "./triggers";

/**
 * What can run and what starts it: named definitions, the schedules that
 * launch them, and the monitors that watch a source. An engine owns one and
 * is the only writer of it; a host adds to it through the engine. A
 * definition without a name is internal and never appears here. Schedules
 * and monitors are keyed by what they trigger and watch.
 */

/** A source to watch on a cadence, and what to do when it changes. */
export interface MonitorRecord {
  /** Called with what changed; a locked node it returns is started. */
  readonly handler: MonitorHandler;
  /** Names the monitor's step, its schedule, and its state file. */
  readonly key: string;
  /** Shown beside the trigger; the key when omitted. */
  readonly label?: string;
  readonly source: MonitorSpec;
  /** How often the source is polled. */
  readonly trigger: Trigger;
}

/** A launchable definition, as a host lists it. */
export interface DefinitionEntry {
  readonly description?: string;
  /** Launch-form fields; an empty list means no arguments. */
  readonly input: { readonly fields: readonly InputField[] };
  readonly inputSchema?: Record<string, unknown>;
  readonly kind: "step" | "workflow";
  readonly name: string;
}

/** The detector step agent-created monitors share; never launchable by hand. */
export const AUTOMATION_MONITOR = "__automation_monitor";

export class Registry {
  readonly definitions = new Map<string, NamedDefinition>();
  /**
   * The detector behind each monitor schedule, by schedule key: the
   * monitors declared here and those agents created. A tick acknowledges a
   * launch it started through these.
   */
  readonly detectors = new Map<string, Detector>();
  /** Keyed like the detector step and the schedule each one adds. */
  readonly monitors = new Map<string, MonitorRecord>();
  readonly schedules = new Map<string, Schedule>();

  define(definition: AnyDefinition): void {
    if (!isNamed(definition)) {
      return;
    }
    const taken = this.definitions.get(definition.name);
    if (taken) {
      throw new Error(
        `"${definition.name}" already registered${quoteOrigin(taken.origin)}; second registration${quoteOrigin(definition.origin)}`
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

  /**
   * A monitor is three things under one key: a step that polls the source
   * and calls the handler on a change, a schedule that runs that step, and
   * the record a host lists.
   */
  monitor(record: MonitorRecord): void {
    const { handler, key, source, trigger } = record;
    if (this.schedules.has(key)) {
      throw new Error(`schedule "${key}" already registered`);
    }
    const watching = detector(key, source, handler);
    this.define({ fn: watching.body, kind: "step", name: key });
    this.detectors.set(key, watching);
    this.schedule({
      input: null,
      key,
      kind: "monitor",
      label: record.label ?? key,
      trigger,
      workflow: key,
    });
    this.monitors.set(key, record);
  }

  /** Launchable definitions, without monitor detectors. */
  entries(): readonly DefinitionEntry[] {
    return [...this.definitions.values()]
      .filter(
        (definition) =>
          definition.name !== AUTOMATION_MONITOR &&
          !this.monitors.has(definition.name)
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
          input: { fields },
          ...(inputSchema === undefined ? {} : { inputSchema }),
          kind: definition.kind,
          name: definition.name,
        };
      });
  }
}
