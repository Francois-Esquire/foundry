import { describe, expect, it, vi } from "vitest";
import { type QuitHost, QuitWindows, registerQuitCleanup } from "~/main/quit";

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
    registerQuitCleanup(host, [[failing, working]], report);

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
    registerQuitCleanup(host, [[cleanup]], () => undefined);

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
    registerQuitCleanup(host, [[cleanup]], () => undefined);

    const first = requestQuit();
    cleanup.reject(new Error("stuck"));
    await first;

    expect(await requestQuit()).toBe(true);
    expect(cleanup.shutdown).toHaveBeenCalledOnce();
    expect(host.quit).toHaveBeenCalledOnce();
  });

  it("drains work before closing what it borrowed, and reports every failure", async () => {
    const { host, requestQuit } = fakeHost();
    const order: string[] = [];
    const step = (name: string, fail = false) => ({
      shutdown: vi.fn(async () => {
        order.push(name);
        if (fail) {
          throw new Error(name);
        }
      }),
    });
    const report = vi.fn();
    registerQuitCleanup(
      host,
      [
        [step("builds"), step("sessions", true)],
        [step("sandboxes", true)],
        [step("engine")],
      ],
      report
    );

    await requestQuit();

    expect(order).toEqual(["builds", "sessions", "sandboxes", "engine"]);
    expect(report.mock.calls.map(([reason]) => reason)).toMatchObject([
      { message: "sessions" },
      { message: "sandboxes" },
    ]);
    expect(host.quit).toHaveBeenCalledOnce();
  });
});

describe("quit confirmation before cleanup", () => {
  it("leaves every service running when the quit is declined, and asks again next time", async () => {
    const { host, requestQuit } = fakeHost();
    const cleanup = { shutdown: vi.fn(() => Promise.resolve()) };
    const confirm = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    registerQuitCleanup(host, [[cleanup]], () => undefined, confirm);

    expect(await requestQuit()).toBe(false);
    expect(cleanup.shutdown).not.toHaveBeenCalled();
    expect(host.quit).not.toHaveBeenCalled();

    expect(await requestQuit()).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(cleanup.shutdown).toHaveBeenCalledOnce();
    expect(host.quit).toHaveBeenCalledOnce();
    expect(await requestQuit()).toBe(true);
  });

  it("holds quit requests raised while confirming, such as the last window closing", async () => {
    const { host, requestQuit } = fakeHost();
    const cleanup = { shutdown: vi.fn(() => Promise.resolve()) };
    const confirmed = Promise.withResolvers<boolean>();
    const confirm = vi.fn(() => confirmed.promise);
    registerQuitCleanup(host, [[cleanup]], () => undefined, confirm);

    const first = requestQuit();
    expect(await requestQuit()).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    expect(cleanup.shutdown).not.toHaveBeenCalled();
    confirmed.resolve(true);
    await first;
    expect(cleanup.shutdown).toHaveBeenCalledOnce();
    expect(host.quit).toHaveBeenCalledOnce();
  });

  it("reports a failed confirmation and keeps running", async () => {
    const { host, requestQuit } = fakeHost();
    const cleanup = { shutdown: vi.fn(() => Promise.resolve()) };
    const report = vi.fn();
    registerQuitCleanup(host, [[cleanup]], report, () =>
      Promise.reject(new Error("window"))
    );
    await requestQuit();
    expect(report).toHaveBeenCalledOnce();
    expect(cleanup.shutdown).not.toHaveBeenCalled();
    expect(host.quit).not.toHaveBeenCalled();
  });
});

describe("QuitWindows", () => {
  function fakeWindow() {
    const listeners = new Set<() => void>();
    const window = {
      close: vi.fn(),
      closed: () => {
        for (const listener of [...listeners]) {
          listeners.delete(listener);
          listener();
        }
      },
      isDestroyed: () => false,
      off: (_event: "closed", listener: () => void) => {
        listeners.delete(listener);
      },
      once: (_event: "closed", listener: () => void) => {
        listeners.add(listener);
      },
    };
    return window;
  }

  it("confirms once every window closed, one after another", async () => {
    const windows = new QuitWindows<ReturnType<typeof fakeWindow>>();
    const [first, second] = [fakeWindow(), fakeWindow()];
    const closing = windows.close([first, second]);
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).not.toHaveBeenCalled();
    first.closed();
    await vi.waitFor(() => expect(second.close).toHaveBeenCalledOnce());
    second.closed();
    expect(await closing).toBe(true);
  });

  it("declines as soon as a person keeps a window open, closing no other", async () => {
    const windows = new QuitWindows<ReturnType<typeof fakeWindow>>();
    const [kept, other] = [fakeWindow(), fakeWindow()];
    const closing = windows.close([kept, other]);
    windows.kept(kept);
    expect(await closing).toBe(false);
    expect(other.close).not.toHaveBeenCalled();
    // A later close of the kept window is no longer this quit's.
    kept.closed();
  });
});
