/**
 * The messages the engine client and the engine worker exchange. A call is a
 * method of the building port and its arguments, so the port is the one place
 * that says what the engine can be asked.
 */
import type { FontBuilder } from "../building";

export type EngineMethod = keyof FontBuilder;

export type EngineCall = {
  [Method in EngineMethod]: {
    readonly args: Parameters<FontBuilder[Method]>;
    readonly kind: Method;
  };
}[EngineMethod];

export type EngineResult = Awaited<ReturnType<FontBuilder[EngineMethod]>>;

export interface ToEngine {
  readonly call: EngineCall;
  readonly id: number;
}

export type FromEngine =
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly message: string }
  | {
      readonly kind: "result";
      readonly id: number;
      readonly value: EngineResult;
    }
  | { readonly kind: "error"; readonly id: number; readonly message: string };
