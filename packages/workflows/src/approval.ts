import type { JsonValue } from "./json-value";
import type { StepContext } from "./step";

export interface ApprovalSuspensionSpec<Resolution> {
  readonly name: string;
  readonly parseResolution: (raw: unknown) => Resolution;
  readonly reason: string;
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
