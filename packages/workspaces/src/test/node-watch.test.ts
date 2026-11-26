import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceChange } from "../catalog";
import { workspaces } from "../node";
import { nodeObserver } from "../node/watch";

const mocks = vi.hoisted(() => ({ watch: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  watch: mocks.watch,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("Node observation backends", () => {
  it("uses recursive fs.watch, skips ignored paths, and falls back to polling on error", async () => {
    vi.useFakeTimers();
    const handle = Object.assign(new EventEmitter(), { close: vi.fn() });
    mocks.watch.mockReturnValue(handle);
    const changed = vi.fn();
    const failed = vi.fn();
    const subscription = await nodeObserver.watch("/root", changed, failed);
    const callback = mocks.watch.mock.calls[0]?.[2] as (
      event: string,
      filename: string
    ) => void;
    callback("rename", "node_modules/a");
    callback("change", ".git/index");
    callback("change", "file.txt");
    expect(changed).toHaveBeenCalledTimes(1);
    handle.emit("error", new Error("stream lost"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(handle.close).toHaveBeenCalledTimes(1);
    await subscription.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("polls when fs.watch fails to start", async () => {
    vi.useFakeTimers();
    mocks.watch.mockImplementation(() => {
      throw new Error("root unavailable");
    });
    const changed = vi.fn();
    const failed = vi.fn();
    const subscription = await nodeObserver.watch("/root", changed, failed);
    await vi.advanceTimersByTimeAsync(1000);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledTimes(1);
    await subscription.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reconciles an external disk write and does not duplicate a save", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    mocks.watch.mockImplementation(actual.watch);
    const root = await mkdtemp(join(tmpdir(), "workspace-watch-"));
    const host = workspaces();
    try {
      const workspace = await host.load({ path: root });
      const changed = vi.fn<(change: WorkspaceChange) => void>();
      host.on("change", changed);
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
      await host.closeAll();
      await rm(root, { force: true, recursive: true });
    }
  });
});
