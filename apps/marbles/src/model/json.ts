/**
 * A value that survived a round trip through JSON. Snapshots build these from
 * run records; the JSON viewer renders them. Plain data, so `model/` imports
 * nothing and both the views and the UI primitives can depend on it.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
