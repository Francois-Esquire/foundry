import type {
  ModuleCapabilityProvider,
  ModuleCapabilitySchema,
} from "@foundry/modules/gateway/types";
import { PORTABLE_SCHEMA_DIALECT } from "@foundry/modules/manifest";
import type { WorksCapability } from "~/main/gateway/provider-kit";

const objectSchema = {
  $schema: PORTABLE_SCHEMA_DIALECT,
  type: "object",
} as const;
const schema: ModuleCapabilitySchema<unknown> = {
  description: objectSchema,
  parse: (value) => value,
};

/**
 * A `host.weather.read@1` capability: its digest is the requested city, so
 * a changed constraint is a changed Grant.
 */
export function weatherProvider(
  invoke: (
    input: unknown,
    context: { readonly signal: AbortSignal }
  ) => Promise<unknown> = () => Promise.resolve({ ok: true })
): WorksCapability {
  const provider = {
    registration: {
      descriptor: {
        capability: "host.weather.read",
        documentation: "Reads the weather.",
        input: objectSchema,
        output: objectSchema,
        version: 1,
      },
      input: schema,
      invoke,
      mode: "unary",
      output: schema,
    },
    resolveConstraints: ({ releaseConstraints }) =>
      Promise.resolve({
        constraintsDigest: `city:${String((releaseConstraints as { city?: string } | null)?.city)}`,
      }),
  } as ModuleCapabilityProvider;
  return { capability: "host.weather.read", provider };
}
