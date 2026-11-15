import { z } from "zod";

import { isJsonValue } from "./json-value";
import { defineOwnEntry } from "./own-entry";

/** Field shapes shared by the workflows record schemas. */

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
): ReadonlyArraySchema<T> {
  return z.array(item) as unknown as ReadonlyArraySchema<T>;
}

/** A `z.ZodArray` at runtime, typed with readonly output and input. */
export interface ReadonlyArraySchema<T extends z.ZodType>
  extends z.ZodType<readonly z.output<T>[], readonly z.input<T>[]> {
  /** The element schema, as on `z.ZodArray`. */
  readonly element: T;
}

export const stringList = readonlyArray(z.string());

/**
 * A string-keyed record, decoded as these records always were: any non-array
 * object is admitted, class instances included, and its own enumerable string
 * keys are kept. `z.record` alone would reject both, and would drop an entry
 * named `__proto__` by assigning it.
 */
export function recordOf<T extends z.ZodType>(entry: T) {
  return z
    .custom<Readonly<Record<string, unknown>>>(isDictionary)
    .transform((input, context) => {
      const output: Record<string, z.output<T>> = {};
      for (const key of Object.keys(input)) {
        const decoded = entry.safeParse(input[key]);
        if (decoded.success) {
          defineOwnEntry(output, key, decoded.data);
        } else {
          for (const issue of decoded.error.issues) {
            // Each issue keeps its own code; only its path gains the entry key.
            context.issues.push({
              ...issue,
              path: [key, ...issue.path],
            } as z.core.$ZodRawIssue);
          }
        }
      }
      return output;
    });
}

function isDictionary(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const unknownRecord = recordOf(z.unknown());

export const JSON_VALUE_MESSAGE = "Expected a finite, acyclic JSON value";

/** JSON-safe data on a field whose declared type stays `unknown`. */
export const jsonSafe = z.custom<unknown>(isJsonValue, JSON_VALUE_MESSAGE);
