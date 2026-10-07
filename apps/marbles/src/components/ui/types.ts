/** Data the primitives display: views build it, primitives only read it. */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface LogEntry {
  readonly id: string;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly stepId?: string;
  readonly timestamp: string;
}
