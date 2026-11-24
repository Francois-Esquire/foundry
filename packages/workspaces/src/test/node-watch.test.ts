import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { nodeObserver } from "../node/watch";

const mocks = vi.hoisted(() => ({ watch: vi.fn() }));
vi.mock("node:fs", () => ({ watch: mocks.watch }));

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
});
