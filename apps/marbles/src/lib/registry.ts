import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { InputField } from "~/lib/inputs";
import type {
  MonitorHandler,
  MonitorRequest,
  MonitorSpec,
} from "~/lib/monitor";
import { detector, handlerResponse } from "~/lib/monitor";
import type { AnyDefinition, NamedDefinition } from "./definition";
import { isNamed, quoteOrigin } from "./definition";
import { fieldsFromJsonSchema, JSON_INPUT_FIELD, jsonSchemaOf } from "./schema";
import type { Schedule, Trigger } from "./triggers";

export interface MonitorRecord {
  readonly handler: MonitorHandler;
  readonly key: string;
  readonly label?: string;
  readonly request?: MonitorRequest;
  readonly source: MonitorSpec;
  readonly trigger: Trigger;
}

export interface DefinitionEntry {
  readonly description?: string;
  readonly input: { readonly fields: readonly InputField[] };
  readonly inputSchema?: Record<string, unknown>;
  readonly kind: "step" | "workflow";
  readonly name: string;
  readonly origin?: string;
}

export const AUTOMATION_MONITOR = "__automation_monitor";

export class Registry {
  readonly #definitions = new Map<string, NamedDefinition>();
  readonly #monitors = new Map<string, MonitorRecord>();
  readonly #schedules = new Map<string, Schedule>();

  get definitions(): ReadonlyMap<string, NamedDefinition> {
    return this.#definitions;
  }

  get monitors(): ReadonlyMap<string, MonitorRecord> {
    return this.#monitors;
  }

  get schedules(): ReadonlyMap<string, Schedule> {
    return this.#schedules;
  }

  define(definition: AnyDefinition): void {
    if (!isNamed(definition)) {
      return;
    }
    const taken = this.#definitions.get(definition.name);
    if (taken) {
      throw new Error(
        `"${definition.name}" already registered${quoteOrigin(taken.origin)}; second registration${quoteOrigin(definition.origin)}`
      );
    }
    this.#definitions.set(definition.name, definition);
  }

  schedule(record: Schedule): void {
    if (this.#schedules.has(record.key)) {
      throw new Error(`schedule "${record.key}" already registered`);
    }
    this.#schedules.set(record.key, record);
  }

  unschedule(key: string): void {
    this.#schedules.delete(key);
  }

  monitor(record: MonitorRecord): void {
    const { handler, key, request, source, trigger } = record;
    if (this.#schedules.has(key)) {
      throw new Error(`schedule "${key}" already registered`);
    }
    this.define({
      fn: detector(key, source, handlerResponse(key, handler), {
        ...(request === undefined ? {} : { request }),
      }),
      kind: "step",
      name: key,
    });
    this.schedule({
      input: null,
      key,
      kind: "monitor",
      label: record.label ?? key,
      trigger,
      workflow: key,
    });
    this.#monitors.set(key, record);
  }

  launchable(name: string): NamedDefinition | undefined {
    return this.#declared(name) ? this.#definitions.get(name) : undefined;
  }

  #declared(name: string): boolean {
    return name !== AUTOMATION_MONITOR && !this.#monitors.has(name);
  }

  entries(): readonly DefinitionEntry[] {
    return [...this.#definitions.values()]
      .filter((definition) => this.#declared(definition.name))
      .map((definition) => {
        const schema = definition.input;
        const inputSchema = schema ? jsonSchemaOf(schema) : undefined;
        return {
          ...(definition.description === undefined
            ? {}
            : { description: definition.description }),
          input: { fields: formFields(schema, inputSchema) },
          ...(inputSchema === undefined ? {} : { inputSchema }),
          kind: definition.kind,
          name: definition.name,
          ...(definition.origin === undefined
            ? {}
            : { origin: definition.origin }),
        };
      });
  }
}

function formFields(
  schema: StandardSchemaV1 | undefined,
  json: Record<string, unknown> | undefined
): readonly InputField[] {
  if (!schema) {
    return [];
  }
  return json ? fieldsFromJsonSchema(json) : [JSON_INPUT_FIELD];
}
