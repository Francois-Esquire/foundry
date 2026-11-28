import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { AnyDefinition } from "~/lib/definitions";
import { quoteOrigin } from "~/lib/definitions";
import type { InputField } from "~/lib/definitions/inputs";
import {
  fieldsFromJsonSchema,
  JSON_INPUT_FIELD,
  jsonSchemaOf,
} from "~/lib/definitions/schema";
import type {
  MonitorHandler,
  MonitorRequest,
  MonitorSpec,
} from "~/lib/schedule/monitor";
import { detector, handlerResponse } from "~/lib/schedule/monitor";
import type { Schedule, Trigger } from "~/lib/schedule/triggers";

export interface MonitorRecord {
  readonly handler: MonitorHandler;
  readonly key: string;
  readonly label?: string;
  readonly request?: MonitorRequest;
  readonly source: MonitorSpec;
  readonly trigger: Trigger;
}

export interface DefinitionRegistration {
  readonly name?: string;
  readonly origin?: string;
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
  readonly #definitions = new Map<string, AnyDefinition>();
  readonly #origins = new Map<string, string | undefined>();
  readonly #monitors = new Map<string, MonitorRecord>();
  readonly #schedules = new Map<string, Schedule>();

  get definitions(): ReadonlyMap<string, AnyDefinition> {
    return this.#definitions;
  }

  get monitors(): ReadonlyMap<string, MonitorRecord> {
    return this.#monitors;
  }

  get schedules(): ReadonlyMap<string, Schedule> {
    return this.#schedules;
  }

  define(
    definition: AnyDefinition,
    registration?: DefinitionRegistration
  ): void {
    const name = registration?.name ?? definition.name;
    if (name === undefined) {
      return;
    }
    const origin = registration?.origin ?? definition.origin;
    const taken = this.#definitions.get(name);
    if (taken) {
      throw new Error(
        `"${name}" already registered${quoteOrigin(this.#origins.get(name) ?? taken.origin)}; second registration${quoteOrigin(origin)}`
      );
    }
    this.#definitions.set(name, definition);
    if (origin !== undefined) {
      this.#origins.set(name, origin);
    }
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

  launchable(name: string): AnyDefinition | undefined {
    return this.#declared(name) ? this.#definitions.get(name) : undefined;
  }

  #declared(name: string): boolean {
    return name !== AUTOMATION_MONITOR && !this.#monitors.has(name);
  }

  entries(): readonly DefinitionEntry[] {
    return [...this.#definitions.entries()]
      .filter(([name]) => this.#declared(name))
      .map(([name, definition]) => {
        const schema = definition.input;
        const inputSchema = schema ? jsonSchemaOf(schema) : undefined;
        const origin = this.#origins.get(name) ?? definition.origin;
        return {
          ...(definition.description === undefined
            ? {}
            : { description: definition.description }),
          input: { fields: formFields(schema, inputSchema) },
          ...(inputSchema === undefined ? {} : { inputSchema }),
          kind: definition.kind,
          name,
          ...(origin === undefined ? {} : { origin }),
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
