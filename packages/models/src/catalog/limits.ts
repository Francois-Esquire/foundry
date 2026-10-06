import type { ModelLimits } from "../types";

/**
 * Token bounds from a wire format's nullable fields. A field the source left
 * out stays absent, which reads as Unknown; `undefined` when it gave neither.
 */
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
