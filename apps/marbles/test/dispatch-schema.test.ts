import { expect, it } from "vitest";
import { dispatchSchema } from "~/workspace/dispatch";

// MCP and the daemon's worker both validate dispatches with this schema.
it("keeps a continued session's whole reference", () => {
  const session = {
    id: "s1",
    implementation: "codex",
    instance: "0123456789abcdef0123456789abcdef",
    model: "gpt-5.5",
    provider: "codex",
  };
  expect(dispatchSchema.parse({ prompt: "again", session }).session).toEqual(
    session
  );
});
