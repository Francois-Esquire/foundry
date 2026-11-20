import { z } from "zod";

import { isJsonValue } from "./json-value";
import { defineOwnEntry } from "./own-entry";

export const anyNumber = z.union([
  z.number(),
  z.nan(),
  z.literal([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]),
]);

export const anyValue = z.unknown().default(undefined);

export const timestamp = z.number();

export const counter = z.number().int().nonnegative();

export function readonlyArray<T extends z.ZodType>(
  item: T
): ReadonlyArraySchema<T> {
  return z.array(item) as unknown as ReadonlyArraySchema<T>;
}

export interface ReadonlyArraySchema<T extends z.ZodType>
  extends z.ZodType<readonly z.output<T>[], readonly z.input<T>[]> {
  readonly element: T;
}

export const stringList = readonlyArray(z.string());

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

export const jsonSafe = z.custom<unknown>(isJsonValue, JSON_VALUE_MESSAGE);
