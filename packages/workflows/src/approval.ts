import type { StepContext } from "./step";
import type { JsonValue } from "./store";

/**
 * Approval suspensions use the engine's durable `(stepPath, name, occurrence)`
 * identity and validate the resolution before returning it to the caller.
 */
export interface ApprovalSuspensionSpec<Resolution> {
  /** The durable Suspension name this kind of approval parks under. */
  readonly name: string;
  /**
   * Validate the engine's resolution before it becomes an answer.
   *
   * The resolution is arbitrary JSON from the engine's perspective. A caller
   * that skips validation is trusting persistence to have written what it
   * expects, which is how a fabricated approval reaches an effect.
   */
  readonly parseResolution: (raw: unknown) => Resolution;
  /** Human-facing reason shown wherever the Suspension surfaces. */
  readonly reason: string;
  /** The request, already narrowed to JSON — it is persisted verbatim. */
  readonly request: JsonValue;
}

export async function suspendForApproval<Resolution>(
  ctx: Pick<StepContext, "suspend">,
  spec: ApprovalSuspensionSpec<Resolution>
): Promise<Resolution> {
  const resolution = await ctx.suspend<unknown>({
    kind: "approval",
    name: spec.name,
    reason: spec.reason,
    request: spec.request,
  });
  return spec.parseResolution(resolution);
}
