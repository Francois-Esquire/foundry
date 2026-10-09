import { describe, expect, it, vi } from "vitest";
import { type QuitHost, registerQuitCleanup } from "~/main/quit";

type Listener = Parameters<QuitHost["on"]>[1];

function fakeHost() {
  let listener: Listener | undefined;
  const host: QuitHost = {
    on: (_event, handler) => {
      listener = handler;
    },
    quit: vi.fn(),
  };
  async function requestQuit(): Promise<boolean> {
    if (!listener) {
      throw new Error("before-quit listener was not registered");
    }
    const preventDefault = vi.fn();
    await listener({ preventDefault });
    return preventDefault.mock.calls.length === 0;
  }
  return { host, requestQuit };
}

function deferredCleanup() {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  return { reject, resolve, shutdown: vi.fn(() => promise) };
}

describe("registerQuitCleanup", () => {
  it("runs every cleanup, reports failures, and quits once they settle", async () => {
    const { host, requestQuit } = fakeHost();
    const report = vi.fn();
    const failing = { shutdown: vi.fn(() => Promise.reject(new Error("vm"))) };
    const working = { shutdown: vi.fn(() => Promise.resolve()) };
    registerQuitCleanup(host, [failing, working], report);

    expect(await requestQuit()).toBe(false);

    expect(failing.shutdown).toHaveBeenCalledOnce();
    expect(working.shutdown).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]?.[0]).toMatchObject({ message: "vm" });
    expect(host.quit).toHaveBeenCalledOnce();
  });

  it("holds repeat quit requests during cleanup without starting it twice", async () => {
    const { host, requestQuit } = fakeHost();
    const cleanup = deferredCleanup();
    registerQuitCleanup(host, [cleanup], () => undefined);

    const first = requestQuit();
    expect(await requestQuit()).toBe(false);
    expect(cleanup.shutdown).toHaveBeenCalledOnce();
    expect(host.quit).not.toHaveBeenCalled();

    cleanup.resolve();
    expect(await first).toBe(false);
    expect(host.quit).toHaveBeenCalledOnce();
  });

  it("lets the quit proceed once cleanup has settled, even after a failure", async () => {
    const { host, requestQuit } = fakeHost();
    const cleanup = deferredCleanup();
    registerQuitCleanup(host, [cleanup], () => undefined);

    const first = requestQuit();
    cleanup.reject(new Error("stuck"));
    await first;

    expect(await requestQuit()).toBe(true);
    expect(cleanup.shutdown).toHaveBeenCalledOnce();
    expect(host.quit).toHaveBeenCalledOnce();
  });
});
