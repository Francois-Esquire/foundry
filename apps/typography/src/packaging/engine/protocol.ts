/** The messages the engine client and the engine worker exchange. */
import type {
  BuildRequest,
  BuiltFont,
  LayoutSummary,
  ValidationReport,
} from "../building";

export type EngineCall =
  | { readonly kind: "build"; readonly request: BuildRequest }
  | {
      readonly kind: "describeLayout";
      readonly faceIndex: number;
      readonly font: Uint8Array;
    }
  | { readonly kind: "validate"; readonly font: Uint8Array };

export interface EngineResults {
  readonly build: BuiltFont;
  readonly describeLayout: LayoutSummary;
  readonly validate: ValidationReport;
}

export type EngineResult = EngineResults[EngineCall["kind"]];

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
