import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { nodeObserver } from "../node/watch";

const mocks = vi.hoisted(() => ({ subscribe: vi.fn(), watch: vi.fn() }));
vi.mock("@parcel/watcher", () => ({ subscribe: mocks.subscribe }));
vi.mock("node:fs", () => ({ watch: mocks.watch }));

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("Node observation backends", () => {
  it("uses Parcel signals and awaits unsubscribe", async () => {
    const unsubscribe = vi.fn().mockResolvedValue(undefined);
    mocks.subscribe.mockResolvedValue({ unsubscribe });
    const changed = vi.fn();
    const failed = vi.fn();
    const subscription = await nodeObserver.watch("/root", changed, failed);
    const callback = mocks.subscribe.mock.calls[0]?.[1] as (
      error: Error | null,
      events: unknown[]
    ) => void;
    callback(null, []);
    callback(null, [{}]);
    expect(changed).toHaveBeenCalledTimes(1);
    await subscription.close();
    callback(null, [{}]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(mocks.watch).not.toHaveBeenCalled();
  });

  it("falls back to Node, then polling on a runtime watcher failure", async () => {
    vi.useFakeTimers();
    mocks.subscribe.mockRejectedValue(new Error("native unavailable"));
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

  it("polls when neither native backend starts", async () => {
    vi.useFakeTimers();
    mocks.subscribe.mockRejectedValue(new Error("native unavailable"));
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
