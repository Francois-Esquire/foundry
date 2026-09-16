import { describe, expect, it, vi } from "vitest";
import { suspendForApproval } from "../approval";
import type { StepContext } from "../step";

/**
 * The published approval-to-Suspension contract every host composes over.
 *
 * These pin the two things a host must not have to re-decide: what gets
 * embedded, and that a resolution is validated before it becomes an answer.
 */

function ctx(resolution: unknown): Pick<StepContext, "suspend"> {
  return { suspend: vi.fn().mockResolvedValue(resolution) };
}

describe("suspendForApproval", () => {
  it("parks under the given name and kind, with the request embedded verbatim", async () => {
    const suspend = vi.fn().mockResolvedValue({ approved: true });
    const context: Pick<StepContext, "suspend"> = { suspend };

    await suspendForApproval(context, {
      name: "agents.tool-approval",
      parseResolution: (raw) => raw as { approved: boolean },
      reason: 'The tool "search" requires approval before it may run.',
      request: { input: { query: "hi" }, tool: "search" },
    });

    expect(suspend).toHaveBeenCalledWith({
      kind: "approval",
      name: "agents.tool-approval",
      reason: 'The tool "search" requires approval before it may run.',
      request: { input: { query: "hi" }, tool: "search" },
    });
  });

  it("returns whatever the host's validator produced, not the raw resolution", async () => {
    const answer = await suspendForApproval(ctx({ approved: true, extra: 1 }), {
      name: "demo",
      parseResolution: () => ({ approved: true as const }),
      reason: "why",
      request: {},
    });

    expect(answer).toEqual({ approved: true });
  });

  /**
   * The resolution is arbitrary JSON from the engine's perspective. A host that
   * throws here fails its Run deterministically; continuing on a fabricated
   * approval is what this contract exists to prevent.
   */
  it("propagates a validator's rejection rather than returning a bad answer", async () => {
    await expect(
      suspendForApproval(ctx({ nonsense: true }), {
        name: "demo",
        parseResolution: () => {
          throw new Error("malformed approval resolution");
        },
        reason: "why",
        request: {},
      })
    ).rejects.toThrow("malformed approval resolution");
  });

  it("never invents a resume key — the name it is given is the name it parks under", async () => {
    const suspend = vi.fn().mockResolvedValue({});
    const context: Pick<StepContext, "suspend"> = { suspend };

    await suspendForApproval(context, {
      name: "modules.capability-approval",
      parseResolution: () => ({}),
      reason: "why",
      request: {},
    });

    expect(suspend.mock.calls[0]?.[0]).toMatchObject({
      name: "modules.capability-approval",
    });
  });
});
