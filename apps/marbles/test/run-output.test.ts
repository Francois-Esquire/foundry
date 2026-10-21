import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processAlive } from "@foundry/lib/file-lock";
import { expect, it, vi } from "vitest";
import { RunOutput } from "~/lib/state/output";
import { watchRun } from "~/watch";

vi.mock("@foundry/lib/file-lock", () => ({ processAlive: vi.fn() }));

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
    const alive = vi.mocked(processAlive);
    alive.mockImplementationOnce(() => {
      // Simulate the owner writing after the zero-byte read, then exiting.
      output.text(finalText);
      output.finish(status);
      return false;
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
      expect(alive).toHaveBeenCalledTimes(1);
    } finally {
      alive.mockReset();
      await rm(root, { force: true, recursive: true });
    }
  }
);
