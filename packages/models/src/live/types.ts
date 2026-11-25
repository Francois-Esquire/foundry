import type { CapabilityFact, InputForm, OperationName } from "../capability";
import type { Media } from "../media";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface LiveTarget {
  readonly fact: CapabilityFact;
  readonly modelId: string;
  readonly operation: OperationName;
  readonly provider: string;
}

export type LiveAccess =
  | {
      readonly kind: "token";
      readonly token: string;
      readonly expiresAt: number;
    }
  | { readonly kind: "proxy"; readonly url: string }
  | { readonly kind: "credential"; readonly credentials: string };

export interface LiveDirection {
  readonly prompt: string;
  readonly settings?: Readonly<Record<string, JsonValue>>;
}

export interface LiveResult {
  readonly direction: number;
  readonly input?: string;
  readonly media: Media;
}

export type LiveClosedReason = "closed" | "disconnected" | "expired";

export interface LiveOptions {
  readonly direction: LiveDirection;
  readonly onClosed?: (reason: LiveClosedReason, message?: string) => void;
  readonly onRefused?: (input: InputForm, reason: string) => void;
  readonly onResult?: (result: LiveResult) => void;
  readonly references?: readonly Media[];
  readonly throttleMs?: number;
}

export type LiveState = "open" | "closed" | "disconnected";

export interface LiveInteraction {
  close(): void;
  direct(direction: LiveDirection): number;
  readonly direction: number;
  reference(media: readonly Media[]): void;
  readonly state: LiveState;
  supply(frame: Media, id?: string): void;
}
