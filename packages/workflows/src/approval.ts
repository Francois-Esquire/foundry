import type { StepContext } from "./step";
import type { JsonValue } from "./store";

/**
 * The one place an approval becomes an ExecutionEngine Suspension.
 *
 * Every approval is the same mechanic under a different vocabulary: park under
 * a durable name, embed the request as JSON, resume with the human's answer.
 * Agent tool calls, module capability calls, a CLI prompt, a Foundry gate — the
 * only thing that differs is the Suspension name and the shape being validated.
 *
 * It lives here rather than in a host because that is what stops each host from
 * growing its own copy. Two of them already had, and they had drifted: one
 * validated its resolution, the other trusted it, and one silently dropped a
 * field the other carried.
 *
 * Resume identity stays the durable `(stepPath, name, occurrence)` tuple the
 * ExecutionEngine owns; nothing here invents its own resume key.
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
