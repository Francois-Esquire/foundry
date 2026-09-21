import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { compose } from "../../agents/compose";

describe("agent composition", () => {
  it("preserves contribution order across asynchronous bindings and tool identity", async () => {
    const inspect = tool({ execute: () => "read", inputSchema: z.object({}) });
    let finish!: (value: { instructions: string }) => void;
    const pending = new Promise<{ instructions: string }>((resolve) => {
      finish = resolve;
    });
    const result = compose(
      pending,
      { instructions: "  domain  ", tools: { inspect } },
      {},
      { instructions: "caller" }
    );
    finish({ instructions: "baseline" });
    expect(await result).toEqual({
      instructions: "baseline\n\ndomain\n\ncaller",
      tools: { inspect },
    });
    expect((await result).tools?.inspect).toBe(inspect);
  });

  it("refuses collisions rather than silently replacing a tool", async () => {
    const inspect = tool({ inputSchema: z.object({}) });
    await expect(
      compose({ tools: { inspect } }, { tools: { inspect } })
    ).rejects.toThrow("Duplicate tool binding: inspect");
  });

  it("propagates a failed binding without returning a partial agent", async () => {
    await expect(
      compose(
        { instructions: "baseline" },
        Promise.reject(new Error("binding unavailable"))
      )
    ).rejects.toThrow("binding unavailable");
  });
});
