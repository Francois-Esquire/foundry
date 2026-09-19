import type { StorageSubscription } from "@foundry/core/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observe, polling } from "../observation";
import type { ObservedFacts, WorkspaceChange } from "../types";

import { WorkspaceSystem } from "../workspace-system";

afterEach(() => {
  vi.useRealTimers();
});

function fixture() {
  let signal: () => void = () => undefined;
  let entries: readonly ObservedFacts[] = [];
  let nextScan: (() => Promise<readonly ObservedFacts[]>) | undefined;
  const closed = vi.fn();
  const subscribed = vi.fn();
  const scan = vi.fn(() => {
    const pending = nextScan;
    nextScan = undefined;
    return pending ? pending() : Promise.resolve(entries);
  });
  const system = new WorkspaceSystem().extend({
    applies: () => true,
    name: "memory",
    wrap: (Base) =>
      class extends Base {
        scan() {
          return scan();
        }
        protected watch(changed: () => void): Promise<StorageSubscription> {
          subscribed();
          signal = changed;
          return Promise.resolve({
            close: () => {
              closed();
              return Promise.resolve();
            },
          });
        }
      },
  });
  return {
    blockScan: (value: () => Promise<readonly ObservedFacts[]>) => {
      nextScan = value;
    },
    closed,
    open: () =>
      system.create({
        name: "test",
        path: "memory:test",
        source: "memory",
        sourceId: null,
      }),
    scan,
    setEntries: (value: readonly ObservedFacts[]) => {
      entries = value;
    },
    signal: () => {
      signal();
    },
    subscribed,
    system,
  };
}

describe("workspace observation", () => {
  it("coalesces signals, emits only differences, and unsubscribes on close", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const workspace = await f.open();
    const changed = vi.fn<(change: WorkspaceChange) => void>();
    f.system.on("change", changed);
    await f.system.open(workspace.id);
    expect(f.subscribed).toHaveBeenCalledTimes(1);
    f.scan.mockClear();
    f.setEntries([{ name: "empty", path: "empty", type: "directory" }]);
    f.signal();
    f.signal();
    f.signal();
    await vi.advanceTimersByTimeAsync(50);
    expect(f.scan).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({
      action: "add",
      entry: { path: "empty" },
    });
    f.signal();
    await vi.advanceTimersByTimeAsync(50);
    expect(changed).toHaveBeenCalledTimes(1);
    f.signal();
    await f.system.closeAll();
    f.signal();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.closed).toHaveBeenCalledTimes(1);
    expect(f.scan).toHaveBeenCalledTimes(2);
  });

  it("rescans when a signal arrives during an external refresh", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const workspace = await f.open();
    const captured = Promise.withResolvers<readonly ObservedFacts[]>();
    const started = Promise.withResolvers<undefined>();
    f.blockScan(() => {
      started.resolve(undefined);
      return captured.promise;
    });
    const refreshing = workspace.refresh();
    await started.promise;
    f.setEntries([{ name: "late", path: "late", type: "directory" }]);
    f.signal();
    await vi.advanceTimersByTimeAsync(50);
    captured.resolve([]);
    await refreshing;
    await vi.advanceTimersByTimeAsync(0);
    expect(await workspace.entries()).toEqual([
      expect.objectContaining({ path: "late" }),
    ]);
    await f.system.closeAll();
  });

  it("retains signals during its own scan and drains before closing", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const workspace = await f.open();
    const captured = Promise.withResolvers<readonly ObservedFacts[]>();
    f.blockScan(() => captured.promise);
    f.signal();
    await vi.advanceTimersByTimeAsync(50);
    f.setEntries([{ name: "socket", path: "socket", type: "socket" }]);
    f.signal();
    captured.resolve([]);
    await vi.advanceTimersByTimeAsync(50);
    expect(await workspace.entries()).toEqual([
      expect.objectContaining({ path: "socket" }),
    ]);

    const last = Promise.withResolvers<readonly ObservedFacts[]>();
    f.blockScan(() => last.promise);
    f.signal();
    await vi.advanceTimersByTimeAsync(50);
    let stopped = false;
    const closing = f.system.close(workspace.id).then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    last.resolve([]);
    await closing;
    expect(stopped).toBe(true);
  });

  it("scans after subscribing and recovers from a failed scan on the next signal", async () => {
    vi.useFakeTimers();
    const failed = vi.fn();
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    let signal: () => void = () => undefined;
    const subscription = await observe(
      (changed) => {
        signal = changed;
        changed();
        return Promise.resolve({ close: () => Promise.resolve() });
      },
      refresh,
      failed
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledTimes(1);
    signal();
    await vi.advanceTimersByTimeAsync(50);
    expect(refresh).toHaveBeenCalledTimes(2);
    await subscription?.close();
  });

  it("stops polling and rejects invalid intervals", async () => {
    vi.useFakeTimers();
    const changed = vi.fn();
    const subscription = await polling(100).watch("/root", changed, vi.fn());
    await vi.advanceTimersByTimeAsync(200);
    expect(changed).toHaveBeenCalledTimes(2);
    await subscription.close();
    await vi.advanceTimersByTimeAsync(200);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(() => polling(0)).toThrow();
  });

  it("allows opening and closing while every scan receives another signal", async () => {
    vi.useFakeTimers();
    let signal: () => void = () => undefined;
    const close = vi.fn().mockResolvedValue(undefined);
    const refresh = vi.fn(() => {
      signal();
      return Promise.resolve();
    });
    const subscription = await observe(
      (changed) => {
        signal = changed;
        return Promise.resolve({ close });
      },
      refresh,
      vi.fn()
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(refresh).toHaveBeenCalledTimes(2);
    await subscription?.close();
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
