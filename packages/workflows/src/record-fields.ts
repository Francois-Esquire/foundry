import { z } from "zod";

import { isJsonValue, isPlainRecord } from "./json-value";

/** Field shapes shared by the workflows record schemas and the metadata codec. */

/** Any JavaScript number, NaN and ±Infinity included. */
export const anyNumber = z.union([
  z.number(),
  z.nan(),
  z.literal([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]),
]);

/** Required `unknown` field. An absent key decodes to `undefined`. */
export const anyValue = z.unknown().default(undefined);

/** Epoch milliseconds. */
export const timestamp = z.number();

/** Ordinals and revisions: non-negative safe integers. */
export const counter = z.number().int().nonnegative();

/**
 * `z.array` typed as a readonly array. Zod's `.readonly()` would also freeze
 * every decoded array, which callers of these records have never seen.
 */
export function readonlyArray<T extends z.ZodType>(
  item: T
): z.ZodType<readonly z.output<T>[], readonly z.input<T>[]> {
  return z.array(item) as unknown as z.ZodType<
    readonly z.output<T>[],
    readonly z.input<T>[]
  >;
}

export const stringList = readonlyArray(z.string());

/**
 * A string-keyed record, decoded as these records always were: any non-array
 * object is admitted, class instances included, and only its own enumerable
 * string keys are kept. `z.record` alone would reject both.
 */
export function recordOf<T extends z.ZodType>(value: T) {
  return z.preprocess(ownStringEntries, z.record(z.string(), value));
}

function ownStringEntries(value: unknown): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : value;
}

export const unknownRecord = recordOf(z.unknown());

export const JSON_VALUE_MESSAGE = "Expected a finite, acyclic JSON value";

/** JSON-safe data on a field whose declared type stays `unknown`. */
export const jsonSafe = z.custom<unknown>(isJsonValue, JSON_VALUE_MESSAGE);

/** Admit only plain data objects, rejecting class instances such as `Error`. */
export function plainObject<T extends z.ZodType>(schema: T) {
  return z.custom<unknown>(isPlainRecord).pipe(schema);
}
