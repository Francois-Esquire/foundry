import type { CapabilityFact, InputForm, Media, OperationName } from "../types";

/**
 * Declared here rather than imported: `@foundry/workflows/store` owns the
 * workspace's `JsonValue`, and this package does not depend on it.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** The exact Model, Operation, and fact one live interaction runs against. */
export interface LiveTarget {
  readonly fact: CapabilityFact;
  readonly modelId: string;
  readonly operation: OperationName;
  readonly provider: string;
}

/**
 * How a party outside the key-owning process reaches a vendor. `credential` is
 * constructible only inside that process and is never produced by `grant`.
 */
export type LiveAccess =
  | {
      readonly kind: "token";
      readonly token: string;
      readonly expiresAt: number;
    }
  | { readonly kind: "proxy"; readonly url: string }
  | { readonly kind: "credential" };

/** What the Model is being asked for right now. Replaced by `direct`. */
export interface LiveDirection {
  readonly prompt: string;
  readonly settings?: Readonly<Record<string, JsonValue>>;
}

/**
 * One delivered output. `direction` is the sequence the output answered — the
 * sequence in force when the input was committed on a `result-per-input`
 * session, and the sequence in force at receipt on a `continuous` one. It is
 * never the latest sequence at delivery time.
 */
export interface LiveResult {
  readonly direction: number;
  readonly input?: string;
  readonly media: Media;
}

export type LiveClosedReason = "closed" | "disconnected" | "expired";

/** Options both entries share; each entry adds its own host-shaped media. */
export interface LiveOptions {
  readonly direction: LiveDirection;
  readonly onClosed?: (reason: LiveClosedReason, message?: string) => void;
  readonly onRefused?: (input: InputForm, reason: string) => void;
  readonly onResult?: (result: LiveResult) => void;
  readonly references?: readonly Media[];
  readonly throttleMs?: number;
}

export type LiveState = "open" | "closed" | "disconnected";

/** The lifecycle both entries share. Host-shaped members live on each entry. */
export interface LiveInteraction {
  close(): void;
  direct(direction: LiveDirection): number;
  readonly direction: number;
  reference(media: readonly Media[]): void;
  readonly state: LiveState;
  supply(frame: Media, id?: string): void;
}
