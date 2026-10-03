import { once } from "node:events";
import { expect, it } from "vitest";
import { createContainers } from "../container/containers";
import { createMemoryContainerStore } from "../container/store";
import { prepareSandboxProcess } from "../process";
import { ProcessController } from "../process-controller";
import { createFakeContainerRuntime } from "../testing";

it("exchanges binary input and separate output through the container process facet", async () => {
  const containers = createContainers({
    instanceLabel: "piped-process",
    runtime: createFakeContainerRuntime({
      spawn: () => {
        const process = new ProcessController(async () => {
          process.stdin.end();
        });
        process.stdin.pipe(process.stdout, { end: false });
        process.stderr.write(new Uint8Array([9, 0, 255]));
        once(process.stdin, "end").then(() => process.complete(7));
        return process;
      },
    }),
    store: createMemoryContainerStore(),
  });
  const container = await containers.start({
    format: "foundry.sandbox.container/1",
  });
  try {
    const child = await container.processes.spawn(["echo-bytes"]);
    expect(child.exitCode).toBeNull();
    expect(child.killed).toBe(false);
    const event = new Promise<[number | null, string | null]>((resolve) =>
      child.once("exit", (code, signal) => resolve([code, signal]))
    );
    child.stdin.end(new Uint8Array([0, 128, 255, 10]));
    const [stdout, stderr, exit] = await Promise.all([
      Array.fromAsync(child.stdout),
      Array.fromAsync(child.stderr),
      child.exited,
    ]);
    expect(Buffer.concat(stdout)).toEqual(Buffer.from([0, 128, 255, 10]));
    expect(Buffer.concat(stderr)).toEqual(Buffer.from([9, 0, 255]));
    expect(exit).toEqual({ exitCode: 7 });
    expect(await event).toEqual([7, null]);
    expect(child.exitCode).toBe(7);
    expect(child.kill()).toBe(false);
  } finally {
    await containers.shutdown();
  }
});

it("queues stdin across an asynchronous launch and preserves deferred output", async () => {
  const gate = Promise.withResolvers<void>();
  const child = prepareSandboxProcess(async () => {
    await gate.promise;
    const process = new ProcessController(async () => {
      process.stdin.end();
    });
    process.stdin.pipe(process.stdout, { end: false });
    once(process.stdin, "end").then(() => process.complete(0));
    return process;
  });
  const data = Buffer.alloc(1024 * 1024, 255);
  expect(child.stdin.write(data)).toBe(false);
  child.stdin.end();
  const output = Array.fromAsync(child.stdout);
  child.stderr.resume();
  gate.resolve();
  expect(Buffer.concat(await output)).toEqual(data);
  expect(await child.exited).toEqual({ exitCode: 0 });
});

it("reports asynchronous launch failures through error and completion", async () => {
  const child = prepareSandboxProcess(() =>
    Promise.reject(new Error("launch fixture failed"))
  );
  const error = new Promise<Error>((resolve) => child.once("error", resolve));
  await expect(child.exited).rejects.toThrow("launch fixture failed");
  expect((await error).message).toBe("launch fixture failed");
  expect(child.stdin.destroyed).toBe(true);
  expect(child.kill()).toBe(false);
});

it("retains a kill requested before launch and supports removing listeners", async () => {
  const gate = Promise.withResolvers<void>();
  const child = prepareSandboxProcess(async () => {
    await gate.promise;
    const process = new ProcessController(async (signal) => {
      expect(signal).toBe("SIGKILL");
      process.complete(137);
    });
    return process;
  });
  child.stdout.resume();
  child.stderr.resume();
  const listener = () => {
    throw new Error("removed listener ran");
  };
  child.on("exit", listener).off("exit", listener);
  expect(child.kill("SIGKILL")).toBe(true);
  expect(child.killed).toBe(true);
  gate.resolve();
  expect(await child.exited).toEqual({ exitCode: 137 });
});

it("reaps after signal delivery fails and preserves the delivery error", async () => {
  const signals: (string | number)[] = [];
  const child = new ProcessController((signal) => {
    signals.push(signal);
    return signal === "SIGKILL"
      ? Promise.resolve()
      : Promise.reject(new Error("signal delivery failed"));
  });
  expect(child.kill("SIGTERM")).toBe(true);
  await expect(child.exited).rejects.toThrow("signal delivery failed");
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(child.stdin.destroyed).toBe(true);
});
