import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceSystem } from "@foundry/workspaces";
import { directory } from "@foundry/workspaces/node";
import { expect, it, vi } from "vitest";
import type { Engine } from "~/engine";
import { runLive } from "~/live";
import { tick } from "~/schedule";

vi.mock("~/schedule", () => ({ tick: vi.fn() }));

it("dispatches workspace changes and retains a change arriving during a tick", async () => {
  const root = await mkdtemp(join(tmpdir(), "live-workspaces-"));
  const system = new WorkspaceSystem().extend(directory());
  const workspace = await system.load({ path: root });
  const abort = new AbortController();
  const first = Promise.withResolvers<undefined>();
  vi.mocked(tick)
    .mockImplementationOnce(() => first.promise)
    .mockResolvedValue(undefined);
  const running = runLive(
    {} as Engine,
    [
      {
        schedule: {
          input: null,
          kind: "monitor",
          name: "files",
          trigger: { kind: "interval", ms: 1000 },
          workflow: "files",
        },
        spec: { glob: "**/*", kind: "files" },
      },
    ],
    {
      print: () => undefined,
      root,
      signal: abort.signal,
      workspaces: {
        load: (ref) => system.load(ref),
        on: (event, listener) => system.on(event, listener),
      },
    }
  );
  try {
    await vi.waitFor(() => {
      expect(tick).toHaveBeenCalledTimes(1);
    });
    await writeFile(join(root, "new.txt"), "new");
    await workspace.refresh();
    expect(tick).toHaveBeenCalledTimes(1);
    first.resolve(undefined);
    await vi.waitFor(() => {
      expect(tick).toHaveBeenCalledTimes(2);
    });
    abort.abort();
    await running;
    await writeFile(join(root, "closed.txt"), "closed");
    await workspace.refresh();
    expect(tick).toHaveBeenCalledTimes(2);
  } finally {
    first.resolve(undefined);
    abort.abort();
    await running;
    await system.closeAll();
    await rm(root, { force: true, recursive: true });
  }
});
