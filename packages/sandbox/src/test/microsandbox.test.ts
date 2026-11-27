import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMicrosandboxRuntime } from "../node/microsandbox";
import { bootGuest } from "./helpers/guest";

const sdk = vi.hoisted(() => {
  class SandboxNotFoundError extends Error {}
  return {
    native: {
      execStreamWith: vi.fn(),
      fs: vi.fn(() => ({ mkdir: () => Promise.resolve() })),
      stopWithTimeout: vi.fn(() => Promise.resolve()),
    },
    remove: vi.fn<(name: string) => Promise<void>>(),
    SandboxNotFoundError,
  };
});

vi.mock("microsandbox", () => {
  const builder: Record<string, unknown> = {};
  for (const method of [
    "cpus",
    "detached",
    "ephemeral",
    "image",
    "labels",
    "memory",
    "network",
    "pullPolicy",
    "quietLogs",
  ]) {
    builder[method] = () => builder;
  }
  builder.create = () => Promise.resolve(sdk.native);
  return {
    Sandbox: { builder: () => builder, remove: sdk.remove },
    SandboxNotFoundError: sdk.SandboxNotFoundError,
  };
});

function handle(events: AsyncIterable<unknown>) {
  return {
    kill: vi.fn(() => Promise.resolve()),
    [Symbol.asyncDispose]: vi.fn(() => Promise.resolve()),
    [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
    takeStdin: vi.fn(() =>
      Promise.resolve({
        close: () => Promise.resolve(),
        write: () => Promise.resolve(),
      })
    ),
    wait: () => Promise.resolve({ code: 0 }),
  };
}

async function* never() {
  await new Promise(() => undefined);
  yield;
}

async function* exited() {
  yield { code: 0, kind: "exited" };
}

beforeEach(() => {
  sdk.remove.mockReset().mockResolvedValue();
  sdk.native.execStreamWith.mockReset();
});

describe("MicroSandbox removal", () => {
  it("treats a VM that is already gone as removed", async () => {
    sdk.remove.mockRejectedValue(new sdk.SandboxNotFoundError("gone"));
    const guest = await bootGuest(createMicrosandboxRuntime());

    await expect(guest[Symbol.asyncDispose]()).resolves.toBeUndefined();
  });

  it("surfaces every other removal failure, so the removal can be retried", async () => {
    sdk.remove.mockRejectedValueOnce(new Error("still running"));
    const guest = await bootGuest(createMicrosandboxRuntime());

    await expect(guest[Symbol.asyncDispose]()).rejects.toThrow("still running");
    await guest[Symbol.asyncDispose]();
    expect(sdk.remove).toHaveBeenCalledTimes(2);
  });
});

describe("MicroSandbox exec handles", () => {
  it("disposes a signalled exec's handle when it finishes", async () => {
    const running = handle(exited());
    sdk.native.execStreamWith.mockResolvedValue(running);
    const guest = await bootGuest(createMicrosandboxRuntime());

    await guest.commands.exec(["true"], {
      signal: new AbortController().signal,
    });

    expect(running[Symbol.asyncDispose]).toHaveBeenCalledOnce();
  });

  it("disposes an aborted exec's handle", async () => {
    const running = handle(never());
    sdk.native.execStreamWith.mockResolvedValue(running);
    const guest = await bootGuest(createMicrosandboxRuntime());
    const controller = new AbortController();

    const result = guest.commands.exec(["sleep", "60"], {
      signal: controller.signal,
    });
    await vi.waitFor(() =>
      expect(sdk.native.execStreamWith).toHaveBeenCalled()
    );
    controller.abort();

    await expect(result).rejects.toThrow("exec aborted");
    expect(running[Symbol.asyncDispose]).toHaveBeenCalledOnce();
  });

  it("disposes a shell's handle on close, once", async () => {
    const running = handle(never());
    sdk.native.execStreamWith.mockResolvedValue(running);
    const guest = await bootGuest(createMicrosandboxRuntime());

    const shell = await guest.shell.open();
    await shell.close();
    await shell.close();

    expect(running[Symbol.asyncDispose]).toHaveBeenCalledOnce();
  });

  it("disposes the handle of a spawn aborted while it was launching", async () => {
    const launching = Promise.withResolvers<ReturnType<typeof handle>>();
    sdk.native.execStreamWith.mockReturnValue(launching.promise);
    const guest = await bootGuest(createMicrosandboxRuntime());
    const controller = new AbortController();

    const spawned = guest.processes.spawn(["serve"], {
      signal: controller.signal,
    });
    await vi.waitFor(() =>
      expect(sdk.native.execStreamWith).toHaveBeenCalled()
    );
    controller.abort(new Error("launch aborted"));
    await expect(spawned).rejects.toThrow("launch aborted");

    const late = handle(never());
    late.kill.mockRejectedValue(new Error("kill failed"));
    launching.resolve(late);
    await vi.waitFor(() =>
      expect(late[Symbol.asyncDispose]).toHaveBeenCalledOnce()
    );
  });
});
