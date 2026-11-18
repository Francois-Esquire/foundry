import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGone } from "@foundry/lib/process-identity";
import { expect, it, vi } from "vitest";
import { RunOutput } from "~/lib/state/output";
import { watchRun } from "~/watch";

vi.mock("@foundry/lib/process-identity", async (actual) => ({
  ...(await actual<typeof import("@foundry/lib/process-identity")>()),
  isGone: vi.fn(),
}));

it.each(["completed", "failed", "cancelled"] as const)(
  "drains the final burst appended between EOF and owner exit (%s)",
  async (status) => {
    const root = await mkdtemp(join(tmpdir(), "marbles-output-race-"));
    const output = new RunOutput(
      join(root, "workspace"),
      "rn-race",
      "race",
      () => undefined
    );
    const finalText = `${"x".repeat(100_000)}final burst 🌿`;
    const gone = vi.mocked(isGone);
    gone.mockImplementationOnce(() => {
      output.text(finalText);
      output.finish(status);
      return true;
    });
    let text = "";
    try {
      expect(
        await watchRun(root, "rn-race", {
          write: (chunk) => {
            text += chunk;
          },
        })
      ).toBe(status);
      expect(text).toContain(finalText);
      expect(text).toContain(`[run] rn-race ${status}`);
      expect(gone).toHaveBeenCalledTimes(1);
    } finally {
      gone.mockReset();
      await rm(root, { force: true, recursive: true });
    }
  }
);
