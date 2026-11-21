import { createHash } from "node:crypto";
import type { InstallationId } from "@foundry/modules/domain";
import type {
  ModuleCapabilityInvocationContext,
  ModuleCapabilityProvider,
  ModuleCapabilitySchema,
  ModuleStreamCapabilityRegistration,
  ModuleUnaryCapabilityRegistration,
} from "@foundry/modules/gateway/types";
import { ModuleGatewayError } from "@foundry/modules/gateway/types";
import {
  PORTABLE_SCHEMA_DIALECT,
  type PortableSchema,
} from "@foundry/modules/manifest";
import { z } from "zod";
import type { ScopeArea } from "~/shared/module-access";

type Shape = Omit<PortableSchema, "$schema" | "items" | "properties"> & {
  readonly items?: PortableSchema;
  readonly properties?: Readonly<Record<string, PortableSchema>>;
};

export function portable(shape: Shape): PortableSchema {
  return { $schema: PORTABLE_SCHEMA_DIALECT, ...shape };
}

export function object(
  properties: Readonly<Record<string, PortableSchema>>,
  requiredKeys: readonly string[],
  description?: string
): PortableSchema {
  return portable({
    additionalProperties: false,
    ...(description ? { description } : {}),
    properties,
    required: requiredKeys,
    type: "object",
  });
}

export const text = (description: string) =>
  portable({ description, type: "string" });
export const integer = (description: string) =>
  portable({ description, type: "integer" });
export const described = (description: string) => portable({ description });

interface Field<Schema extends z.ZodType = z.ZodType> {
  readonly description: PortableSchema;
  readonly required: boolean;
  readonly schema: Schema;
}

export function required<Schema extends z.ZodType>(
  schema: Schema,
  description: PortableSchema
): Field<Schema> {
  return { description, required: true, schema };
}

export function optional<Schema extends z.ZodType>(
  schema: Schema,
  description: PortableSchema
): Field<z.ZodOptional<Schema>> {
  return { description, required: false, schema: schema.optional() };
}

type FieldShape<Table extends Record<string, Field>> = {
  [Key in keyof Table]: Table[Key]["schema"];
};

export function fields<Table extends Record<string, Field>>(
  table: Table,
  description?: string
): ModuleCapabilitySchema<z.infer<z.ZodObject<FieldShape<Table>>>> & {
  readonly schema: z.ZodObject<FieldShape<Table>, z.core.$strict>;
} {
  const entries = Object.entries(table);
  const schema = z.strictObject(
    Object.fromEntries(
      entries.map(([name, field]) => [name, field.schema])
    ) as FieldShape<Table>
  );
  return {
    description: object(
      Object.fromEntries(
        entries.map(([name, field]) => [name, field.description])
      ),
      entries.filter(([, field]) => field.required).map(([name]) => name),
      description
    ),
    parse: (value) => schema.parse(value),
    schema,
  };
}

export function input<Value>(
  schema: z.ZodType<Value>,
  description: PortableSchema
): ModuleCapabilitySchema<Value> {
  return { description, parse: (value) => schema.parse(value) };
}

function passThrough(
  description: PortableSchema
): ModuleCapabilitySchema<unknown> {
  return { description, parse: (value) => value };
}

export interface CapabilityPolicy<Value> {
  resolve(constraints: unknown): ResolvedPolicy<Value>;
}

export interface ResolvedPolicy<Value> {
  readonly digest: string;
  readonly value: Value;
}

export function noConstraints(
  capability: string,
  label: string,
  refusal: string
): CapabilityPolicy<null> {
  return {
    resolve(constraints) {
      if (constraints !== null && constraints !== undefined) {
        throw new Error(refusal);
      }
      return { digest: `${capability}@1:${label}`, value: null };
    },
  };
}

export function constrained<Value>(
  capability: string,
  parse: (constraints: unknown) => Value
): CapabilityPolicy<Value> {
  return {
    resolve(constraints) {
      const value = parse(constraints);
      return {
        digest: `${capability}@1:${createHash("sha256")
          .update(JSON.stringify(value))
          .digest("hex")}`,
        value,
      };
    },
  };
}

export interface GrantChange {
  readonly installationId: InstallationId;
  readonly moduleId: string;
}

interface GrantChangeReport {
  readonly restarted?: number;
}

type GrantChangeHook = (
  change: GrantChange
) => void | Promise<void> | Promise<GrantChangeReport>;

export interface WorksCapability {
  readonly approved?: GrantChangeHook;
  readonly capability: string;
  readonly provider?: ModuleCapabilityProvider;
  readonly revoked?: GrantChangeHook;
  readonly scope?: {
    readonly area: ScopeArea;
    of(constraints: unknown): readonly string[] | undefined;
  };
}

interface CapabilitySpec<Input, Value> {
  readonly capability: string;
  readonly documentation: string;
  readonly input: ModuleCapabilitySchema<Input>;
  readonly policy: CapabilityPolicy<Value>;
  readonly revoked?: WorksCapability["revoked"];
  readonly scope?: {
    readonly area: ScopeArea;
    of(value: Value): readonly string[];
  };
}

function record<Value>(
  spec: CapabilitySpec<unknown, Value>,
  registration: ModuleCapabilityProvider["registration"]
): WorksCapability {
  const { policy, scope } = spec;
  return {
    capability: spec.capability,
    provider: {
      registration,
      resolveConstraints: ({ releaseConstraints }) =>
        new Promise((resolve) => {
          resolve({
            constraintsDigest: policy.resolve(releaseConstraints).digest,
          });
        }),
    },
    ...(spec.revoked ? { revoked: spec.revoked } : {}),
    ...(scope
      ? {
          scope: {
            area: scope.area,
            of(constraints: unknown) {
              try {
                return scope.of(policy.resolve(constraints).value);
              } catch {
                // Constraints this host refuses reach nothing.
              }
            },
          },
        }
      : {}),
  };
}

export function defineUnary<Input, Value>(
  spec: CapabilitySpec<Input, Value> & {
    readonly output: PortableSchema;
    invoke(
      input: Input,
      context: ModuleCapabilityInvocationContext,
      policy: ResolvedPolicy<Value>
    ): Promise<unknown>;
  }
): WorksCapability {
  const registration: ModuleUnaryCapabilityRegistration<Input, unknown> = {
    descriptor: {
      capability: spec.capability,
      documentation: spec.documentation,
      input: spec.input.description,
      output: spec.output,
      version: 1,
    },
    input: spec.input,
    invoke: (value, context) =>
      spec.invoke(value, context, spec.policy.resolve(context.constraints)),
    mode: "unary",
    output: passThrough(spec.output),
  };
  return record(spec, registration);
}

export function defineStream<Input, Value>(
  spec: CapabilitySpec<Input, Value> & {
    readonly event: PortableSchema | ModuleCapabilitySchema<unknown>;
    invoke(
      input: Input,
      context: ModuleCapabilityInvocationContext,
      policy: ResolvedPolicy<Value>
    ): AsyncIterable<unknown>;
  }
): WorksCapability {
  const event = "parse" in spec.event ? spec.event : passThrough(spec.event);
  const registration: ModuleStreamCapabilityRegistration<Input, unknown> = {
    descriptor: {
      capability: spec.capability,
      documentation: spec.documentation,
      event: event.description,
      input: spec.input.description,
      version: 1,
    },
    event,
    input: spec.input,
    invoke: (value, context) =>
      spec.invoke(value, context, spec.policy.resolve(context.constraints)),
    mode: "stream",
  };
  return record(spec, registration);
}

export function denied(message: string): ModuleGatewayError {
  return new ModuleGatewayError("unauthorized", message);
}

export function unavailable<Services extends object>(what: string): Services {
  return new Proxy({} as Services, {
    get() {
      throw new Error(`${what} are unavailable`);
    },
  });
}
