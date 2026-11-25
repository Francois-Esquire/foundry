import { z } from "zod";
import {
  AGENT_DEFINITION,
  AGENT_PROMPT,
  DEFINITION_IDENTITY,
  SANDBOX_HANDLE,
} from "~/lib/handles";

export type PoolConfig = number | { readonly limit: number };
export interface MarblesConfig {
  readonly pool?: string;
  readonly pools?: Readonly<Record<string, PoolConfig>>;
}
export function defineConfig(config: MarblesConfig): MarblesConfig {
  return config;
}

const limitSchema = z.custom<number>(
  (n) =>
    typeof n === "number" &&
    (n === Number.POSITIVE_INFINITY || (Number.isInteger(n) && n >= 1)),
  "a pool limit must be a positive integer or Infinity"
);
const nameSchema = z
  .string()
  .refine(
    (value) => value.length > 0 && value.trim() === value,
    "a pool name must be non-blank with no leading or trailing whitespace"
  );
const schema = z.strictObject({
  pool: nameSchema.optional(),
  pools: z
    .record(
      nameSchema,
      z.union([limitSchema, z.strictObject({ limit: limitSchema })])
    )
    .optional(),
});

export function configOf(
  file: string,
  value: unknown
): MarblesConfig | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    "kind" in value ||
    [AGENT_DEFINITION, AGENT_PROMPT, DEFINITION_IDENTITY, SANDBOX_HANDLE].some(
      (marker) => marker in value
    )
  ) {
    return;
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${file}: invalid Marbles config: ${parsed.error.message}`);
  }
  return parsed.data;
}
