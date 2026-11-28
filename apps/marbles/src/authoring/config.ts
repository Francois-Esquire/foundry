import { z } from "zod";
import {
  AGENT_DEFINITION,
  AGENT_META,
  AGENT_PROMPT,
  DEFINITION_IDENTITY,
  MONITOR_META,
  OBSERVER_META,
  PROVIDER_DECLARATION,
  SANDBOX_HANDLE,
  SCHEDULE_META,
} from "~/lib/definitions/handles";

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

const NON_CONFIG_MARKERS = [
  AGENT_DEFINITION,
  AGENT_META,
  AGENT_PROMPT,
  DEFINITION_IDENTITY,
  MONITOR_META,
  OBSERVER_META,
  PROVIDER_DECLARATION,
  SANDBOX_HANDLE,
  SCHEDULE_META,
] as const;

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
    NON_CONFIG_MARKERS.some((marker) => marker in value)
  ) {
    return;
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${file}: invalid Marbles config: ${parsed.error.message}`);
  }
  return parsed.data;
}
