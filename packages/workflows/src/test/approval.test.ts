import { describe, expect, it, vi } from "vitest";
import { suspendForApproval } from "../approval";
import type { StepContext } from "../step";
import { Step } from "../step";
import { Workflow } from "../workflow";

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

  it("carries an opaque correlationId through to the suspension request", async () => {
    const suspend = vi.fn().mockResolvedValue({ approved: true });
    const context: Pick<StepContext, "suspend"> = { suspend };

    await suspendForApproval(context, {
      correlationId: "grant-123",
      name: "agents.tool-approval",
      parseResolution: (raw) => raw as { approved: boolean },
      reason: "requires approval",
      request: { tool: "shell" },
    });

    expect(suspend).toHaveBeenCalledWith({
      correlationId: "grant-123",
      kind: "approval",
      name: "agents.tool-approval",
      reason: "requires approval",
      request: { tool: "shell" },
    });
  });

  it("prevents bare-name resolution and cross-step resolution for same-named approvals", async () => {
    const parseApproval = (raw: unknown): { approved: boolean } => {
      if (
        typeof raw === "object" &&
        raw !== null &&
        "approved" in raw &&
        typeof raw.approved === "boolean"
      ) {
        return { approved: raw.approved };
      }
      throw new Error("invalid approval resolution");
    };

    const wf = Workflow.attach(
      Step.create<void, { a: boolean; b: boolean }>({
        execute: async (_input, stepCtx) => {
          const [stepA, stepB] = stepCtx.children;
          if (!(stepA && stepB)) {
            throw new Error("expected stepA and stepB");
          }
          const a = (await stepA.run()) as boolean;
          const b = (await stepB.run()) as boolean;
          return { a, b };
        },
        input: undefined,
        name: "wf",
      })
        .step<void, boolean>({
          execute: async (_input, stepCtx) => {
            const answer = await suspendForApproval(stepCtx, {
              correlationId: "grant-a",
              name: "approval",
              parseResolution: parseApproval,
              reason: "approve step A",
              request: { step: "A" },
            });
            return answer.approved;
          },
          input: undefined,
          name: "stepA",
        })
        .step<void, boolean>({
          execute: async (_input, stepCtx) => {
            const answer = await suspendForApproval(stepCtx, {
              correlationId: "grant-b",
              name: "approval",
              parseResolution: parseApproval,
              reason: "approve step B",
              request: { step: "B" },
            });
            return answer.approved;
          },
          input: undefined,
          name: "stepB",
        }),
      undefined
    );

    await wf.run().catch(() => undefined);
    expect(wf.status).toBe("suspended");
    expect(wf.state.suspension).toMatchObject({
      correlationId: "grant-a",
      kind: "approval",
      name: "approval",
      stepPath: ["wf", "stepA"],
    });

    await wf.resume("approval", { approved: true });
    await wf.run().catch(() => undefined);
    expect(wf.status).toBe("suspended");
    expect(wf.state.suspension?.stepPath).toEqual(["wf", "stepA"]);

    await wf.resumeOccurrence(
      ["wf", "stepA"],
      "approval",
      0,
      { approved: true },
      "grant-wrong"
    );
    await wf.run().catch(() => undefined);
    expect(wf.status).toBe("suspended");
    expect(wf.state.suspension?.stepPath).toEqual(["wf", "stepA"]);

    await wf.resumeOccurrence(
      ["wf", "stepA"],
      "approval",
      0,
      { approved: true },
      "grant-a"
    );
    await wf.run().catch(() => undefined);
    expect(wf.status).toBe("suspended");
    expect(wf.state.suspension).toMatchObject({
      correlationId: "grant-b",
      kind: "approval",
      name: "approval",
      stepPath: ["wf", "stepB"],
    });

    await wf.resumeOccurrence(
      ["wf", "stepB"],
      "approval",
      0,
      { approved: false },
      "grant-b"
    );
    await expect(wf.run()).resolves.toEqual({ a: true, b: false });
  });
});
