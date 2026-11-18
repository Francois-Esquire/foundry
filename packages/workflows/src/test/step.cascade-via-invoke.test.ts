import { describe, expect, it } from "vitest";

import { Step } from "../step";

describe("cascade via ctx.invoke", () => {
  it("an invoked step with declared children drains them (post-body cascade)", async () => {
    const ran: string[] = [];

    const invoked = Step.create<void, "invoked-out">({
      children: [
        {
          execute: async () => {
            ran.push("leaf-a");
            return "a-out";
          },
          input: undefined,
          name: "leaf-a",
        },
        {
          execute: async () => {
            ran.push("leaf-b");
            return "b-out";
          },
          input: undefined,
          name: "leaf-b",
        },
      ],
      execute: async (): Promise<"invoked-out"> => {
        ran.push("invoked-body");
        return "invoked-out";
      },
      input: undefined,
      name: "invoked",
    });

    const root = Step.create<void, "ok">({
      execute: async (_input, ctx): Promise<"ok"> => {
        const out = await ctx.invoke(invoked, undefined);
        expect(out).toBe("invoked-out");
        return "ok";
      },
      input: undefined,
      name: "root",
    });

    await root.run();

    expect(ran).toEqual(["invoked-body", "leaf-a", "leaf-b"]);

    const { steps } = invoked;
    expect(steps["invoked.leaf-a"]?.status).toBe("complete");
    expect(steps["invoked.leaf-b"]?.status).toBe("complete");
  });
});

describe("cascade via ctx.parallel", () => {
  it("a parallel entry with declared children drains them", async () => {
    const ran: string[] = [];

    const worker = Step.create<unknown, unknown>({
      children: [
        {
          execute: async () => {
            ran.push("sub");
            return "sub-out";
          },
          input: undefined,
          name: "sub",
        },
      ],
      execute: async () => {
        ran.push("worker-body");
        return "worker-out";
      },
      input: undefined,
      name: "worker",
    });

    const root = Step.create<void, "ok">({
      execute: async (_input, ctx): Promise<"ok"> => {
        const out = await ctx.parallel({
          w: { input: undefined, step: worker },
        });
        expect(out.w).toBe("worker-out");
        return "ok";
      },
      input: undefined,
      name: "root",
    });

    await root.run();

    expect(ran).toEqual(["worker-body", "sub"]);
    expect(worker.steps["worker.sub"]?.status).toBe("complete");
  });
});
