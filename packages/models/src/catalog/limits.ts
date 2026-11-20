import type { ModelLimits } from "../types";

export function tokenLimits(
  maxInputTokens: number | null | undefined,
  maxOutputTokens: number | null | undefined
): ModelLimits | undefined {
  const limits = {
    ...(maxInputTokens === null || maxInputTokens === undefined
      ? {}
      : { maxInputTokens }),
    ...(maxOutputTokens === null || maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens }),
  };
  return Object.keys(limits).length > 0 ? limits : undefined;
}
