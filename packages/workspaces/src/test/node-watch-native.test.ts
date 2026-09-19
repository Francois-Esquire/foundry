import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { directory } from "../node";
import { nodeObserver } from "../node/watch";
import type { WorkspaceChange } from "../types";

import { WorkspaceSystem } from "../workspace-system";

it("reconciles an external disk write and does not duplicate a save", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-watch-"));
  const system = new WorkspaceSystem().extend(
    directory({ observer: nodeObserver })
  );
  try {
    const workspace = await system.add({ path: root });
    const changed = vi.fn<(change: WorkspaceChange) => void>();
    system.on("change", changed);
    await writeFile(join(root, "a.txt"), "external");
    await vi.waitFor(
      () => {
        expect(changed).toHaveBeenCalledTimes(1);
      },
      { timeout: 3000 }
    );
    expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({
      action: "add",
      entry: { path: "a.txt" },
    });
    const [file] = await workspace.files();
    if (!file) {
      throw new Error("Expected observed file");
    }
    await workspace.save({
      expectedDigest: file.digest,
      fileId: file.id,
      text: "saved",
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(changed).toHaveBeenCalledTimes(2);
  } finally {
    await system.closeAll();
    await rm(root, { force: true, recursive: true });
  }
});
