import { expect, it, vi } from "vitest";
import { relay } from "~/mcp/relay";

vi.mock("~/process/runtime", () => ({
  RUNTIME_FLAGS: [],
  runtime: () => "/nonexistent/marbles-runtime",
}));

it("reports the spawn error when the server cannot start", async () => {
  await expect(relay("entry.ts", [])).rejects.toMatchObject({
    code: "ENOENT",
  });
});
