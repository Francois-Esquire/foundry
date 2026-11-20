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
