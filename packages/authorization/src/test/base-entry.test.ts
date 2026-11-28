import { describe, expect, it } from "vitest";
import { Authorization, Permit } from "../index";
import { MemoryAuthorizationStore } from "../store/memory";

describe("@foundry/authorization base entry", () => {
  it("evaluates and runs Authorization over MemoryAuthorizationStore without Node adapters", async () => {
    const auth = new Authorization({ store: new MemoryAuthorizationStore() });
    const decision = await auth.check({
      action: "file.read",
      principal: { id: "agent-1", kind: "agent" },
      target: "/workspace/README.md",
    });
    expect(decision.kind).toBe("ask");
    expect(await auth.listGrants()).toEqual([]);
    expect(await auth.listRestrictions()).toEqual([]);
  });

  it("refuses direct construction of Permit", () => {
    const fakeToken = Symbol("fake");
    expect(
      () =>
        new Permit(
          fakeToken,
          {
            grantId: "grt_1" as never,
            grantPath: [],
            invocationId: "inv_1",
            issuedAt: 0,
          },
          new AbortController().signal,
          () => undefined
        )
    ).toThrow(TypeError);
  });
});
