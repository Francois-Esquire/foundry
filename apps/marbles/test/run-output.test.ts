import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGone } from "@foundry/lib/node/process-identity";
import { expect, it, vi } from "vitest";
import { watchRun } from "~/cli/watch";
import { RunOutput } from "~/lib/state/output";

vi.mock("@foundry/lib/node/process-identity", async (actual) => ({
  ...(await actual<typeof import("@foundry/lib/node/process-identity")>()),
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

it("checks the new owner when a start record arrives after the old owner exited", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-output-adopted-"));
  const old = new RunOutput(
    join(root, "workspace"),
    "rn-adopted",
    "adopted",
    () => undefined
  );
  const gone = vi.mocked(isGone);
  let adopter: RunOutput | undefined;
  gone.mockImplementationOnce(() => {
    adopter = new RunOutput(
      join(root, "workspace"),
      "rn-adopted",
      "adopted",
      () => undefined
    );
    return true;
  });
  let text = "";
  try {
    const watching = watchRun(root, "rn-adopted", {
      write: (chunk) => {
        text += chunk;
      },
    });
    await vi.waitFor(() =>
      expect(text.match(/adopted running/g)).toHaveLength(2)
    );
    await vi.waitFor(() => expect(gone).toHaveBeenCalledTimes(2));
    adopter?.finish("completed", "taken over");
    expect(await watching).toBe("completed");
    expect(text).toContain("taken over");
  } finally {
    old.finish("cancelled");
    gone.mockReset();
    await rm(root, { force: true, recursive: true });
  }
});
