import { Readable } from "node:stream";
import { createFakeContainerRuntime } from "@foundry/sandbox/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBuildRuntime } from "~/main/modules/builds/runtime";

const native = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("@foundry/sandbox/node/microsandbox", () => ({
  createMicrosandboxRuntime: native.create,
}));

vi.mock("~/main/modules/builds/workspace", () => ({
  auditBuildWorkspace: vi.fn(async () => undefined),
}));

function exited(exitCode: number) {
  return {
    exited: Promise.resolve({ exitCode }),
    stderr: Readable.from([]),
    stdin: { end: () => undefined },
    stdout: Readable.from([]),
  } as never;
}

async function build(exitCode: number) {
  const runtime = createFakeContainerRuntime({
    files: {
      "/workspace/bun.lock": "{}",
      "/workspace/packages/app/dist/index.js": "export {};",
    },
    spawn: () => exited(exitCode),
  });
  const closeFailure = new Error("VM removal failed");
  const create = runtime.create.bind(runtime);
  runtime.create = async (spec) => {
    const instance = await create(spec);
    vi.spyOn(instance, "remove").mockRejectedValueOnce(closeFailure);
    return instance;
  };
  native.create.mockReturnValue(runtime);
  const builds = await createBuildRuntime("/user-data");
  const failure: unknown = await builds
    .run({}, new AbortController().signal, () => undefined)
    .then(
      () => undefined,
      (error: unknown) => error
    );
  return { builds, closeFailure, failure, runtime };
}

describe("build container cleanup", () => {
  beforeEach(() => {
    native.create.mockReset();
  });

  it("keeps both the build error and the cleanup error", async () => {
    const { builds, closeFailure, failure, runtime } = await build(1);

    expect(failure).toBeInstanceOf(AggregateError);
    const { cause, errors, message } = failure as AggregateError;
    expect(errors).toEqual([cause, closeFailure]);
    expect((cause as Error).message).toContain("installing failed (exit 1)");
    expect(message).toContain("installing failed (exit 1)");
    expect(message).toContain("VM removal failed");

    await builds.shutdown();
    expect(runtime.instances[0]?.removed).toBe(true);
  });

  it("reports the cleanup error of a build that succeeded", async () => {
    const { builds, closeFailure, failure, runtime } = await build(0);

    expect(failure).toBe(closeFailure);

    await builds.shutdown();
    expect(runtime.instances[0]?.removed).toBe(true);
  });
});
