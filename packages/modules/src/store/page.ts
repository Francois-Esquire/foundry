import type { Page, PageInput } from "@foundry/core/pagination";

import { pageAfter, pageLimit } from "@foundry/lib/pagination";

import { ModuleStoreConflictError } from "./contract";

export function page<Value>(
  values: readonly Value[],
  input: PageInput,
  identity: (value: Value) => string,
  copy: (value: Value) => Value
): Page<Value> {
  try {
    const result = pageAfter(
      values,
      { ...input, limit: pageLimit(input.limit, { max: 100 }) },
      identity
    );
    return Object.freeze({
      ...result,
      items: Object.freeze(result.items.map(copy)),
    });
  } catch (error) {
    if (error instanceof RangeError) {
      throw new ModuleStoreConflictError(error.message, { cause: error });
    }
    throw error;
  }
}
