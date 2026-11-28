import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMicrosandboxDriver } from "../providers/microsandbox";
import { bootGuest } from "./helpers/guest";

const sdk = vi.hoisted(() => {
  class SandboxNotFoundError extends Error {}
  return {
    installRuntime: vi.fn(() => Promise.resolve({})),
    isRuntimeInstalled: vi.fn(() => true),
    native: {
      execStreamWith: vi.fn(),
      fs: vi.fn(() => ({ mkdir: () => Promise.resolve() })),
      stopWithTimeout: vi.fn(() => Promise.resolve()),
    },
    remove: vi.fn<(name: string) => Promise<void>>(),
    resolveRuntime: vi.fn(() => ({ msbPath: "/runtime/msb" })),
    resolveRuntimeVersion: vi.fn<() => Promise<string | null>>(),
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
    installRuntime: sdk.installRuntime,
    isRuntimeInstalled: sdk.isRuntimeInstalled,
    resolveRuntime: sdk.resolveRuntime,
    resolveRuntimeVersion: sdk.resolveRuntimeVersion,
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
  sdk.isRuntimeInstalled.mockReset().mockReturnValue(true);
  sdk.resolveRuntimeVersion.mockReset().mockResolvedValue("0.7.16");
  sdk.remove.mockReset().mockResolvedValue();
  sdk.native.execStreamWith.mockReset();
});

describe("Microsandbox runtime compatibility", () => {
  it("requires the runtime version matching the SDK", async () => {
    const driver = createMicrosandboxDriver();
    await expect(driver.isInstalled?.()).resolves.toBe(true);
    for (const version of [null, "0.6.18", "0.8.3"]) {
      sdk.resolveRuntimeVersion.mockResolvedValue(version);
      await expect(driver.isInstalled?.()).resolves.toBe(false);
    }
  });

  it("does not resolve an absent runtime", async () => {
    sdk.isRuntimeInstalled.mockReturnValue(false);
    await expect(createMicrosandboxDriver().isInstalled?.()).resolves.toBe(
      false
    );
    expect(sdk.resolveRuntimeVersion).not.toHaveBeenCalled();
  });

  it("installs the pinned runtime explicitly", async () => {
    await createMicrosandboxDriver().install?.();
    expect(sdk.installRuntime).toHaveBeenCalledWith({}, { version: "0.7.16" });
  });
});

describe("MicroSandbox removal", () => {
  it("treats a VM that is already gone as removed", async () => {
    sdk.remove.mockRejectedValue(new sdk.SandboxNotFoundError("gone"));
    const guest = await bootGuest(createMicrosandboxDriver());

    await expect(guest[Symbol.asyncDispose]()).resolves.toBeUndefined();
  });

  it("surfaces every other removal failure, so the removal can be retried", async () => {
    sdk.remove.mockRejectedValueOnce(new Error("still running"));
    const guest = await bootGuest(createMicrosandboxDriver());

    await expect(guest[Symbol.asyncDispose]()).rejects.toThrow("still running");
    await guest[Symbol.asyncDispose]();
    expect(sdk.remove).toHaveBeenCalledTimes(2);
  });
});

describe("MicroSandbox exec handles", () => {
  it("completes an exited process without sending EOF to its closed stdin", async () => {
    const running = handle(exited());
    const close = vi.fn(() =>
      Promise.reject(new Error("execution stdin closed"))
    );
    running.takeStdin.mockResolvedValue({
      close,
      write: () => Promise.resolve(),
    });
    sdk.native.execStreamWith.mockResolvedValue(running);
    const guest = await bootGuest(createMicrosandboxDriver());
    const process = await guest.processes?.spawn?.(["true"]);

    await expect(process?.exited).resolves.toEqual({ exitCode: 0 });
    expect(close).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(running[Symbol.asyncDispose]).toHaveBeenCalledOnce()
    );
  });

  it("disposes a signalled exec's handle when it finishes", async () => {
    const running = handle(exited());
    sdk.native.execStreamWith.mockResolvedValue(running);
    const guest = await bootGuest(createMicrosandboxDriver());

    await guest.commands.exec(["true"], {
      signal: new AbortController().signal,
    });

    expect(running[Symbol.asyncDispose]).toHaveBeenCalledOnce();
  });

  it("disposes an aborted exec's handle", async () => {
    const running = handle(never());
    sdk.native.execStreamWith.mockResolvedValue(running);
    const guest = await bootGuest(createMicrosandboxDriver());
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
    const guest = await bootGuest(createMicrosandboxDriver());

    if (!guest.shell) {
      throw new Error("expected shell");
    }
    const shell = await guest.shell.open();
    await shell.close();
    await shell.close();

    expect(running[Symbol.asyncDispose]).toHaveBeenCalledOnce();
  });

  it("disposes the handle of a spawn aborted while it was launching", async () => {
    const launching = Promise.withResolvers<ReturnType<typeof handle>>();
    sdk.native.execStreamWith.mockReturnValue(launching.promise);
    const guest = await bootGuest(createMicrosandboxDriver());
    const controller = new AbortController();

    const spawned = guest.processes?.spawn?.(["serve"], {
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
