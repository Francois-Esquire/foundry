import { expect, it } from "vitest";
import { createContainers } from "../containers/containers";
import { prepareSandboxProcess } from "../node/prepare-process";
import { createMicrosandboxDriver } from "../providers/microsandbox";
import { MemoryContainerStore } from "../store/memory";

it("drives real public process pipes through the immediate hook and cancels them on close", async () => {
  const containers = createContainers({
    driver: createMicrosandboxDriver(),
    instanceLabel: `piped-lifecycle-${crypto.randomUUID()}`,
    store: new MemoryContainerStore(),
  });
  try {
    const container = await containers.start({
      image: "docker.io/oven/bun:1-slim",
    });
    const child = prepareSandboxProcess(() => {
      if (!container.processes?.spawn) {
        throw new Error("expected spawn");
      }
      return container.processes.spawn([
        "bun",
        "-e",
        "process.stdin.pipe(process.stdout);process.stderr.write(Buffer.from([0,255]));process.stdin.on('end',()=>process.exitCode=7);",
      ]);
    });
    const payload = Buffer.alloc(1024 * 1024, 128);
    child.stdin.end(payload);
    const [stdout, stderr, exit] = await Promise.all([
      Array.fromAsync(child.stdout),
      Array.fromAsync(child.stderr),
      child.exited,
    ]);
    const received = Buffer.concat(stdout);
    expect(received.byteLength).toBe(payload.byteLength);
    expect(received.equals(payload)).toBe(true);
    expect(Buffer.concat(stderr)).toEqual(Buffer.from([0, 255]));
    expect(exit.exitCode).toBe(7);
    if (!container.processes?.spawn) {
      throw new Error("expected spawn");
    }
    const running = await container.processes.spawn([
      "bun",
      "-e",
      "setInterval(()=>process.stdout.write(Buffer.alloc(1024*1024)),5)",
    ]);
    const stopped = expect(running.exited).rejects.toThrow("Sandbox removed");
    await container.close();
    await stopped;
    expect(running.stdin.destroyed).toBe(true);
    expect(running.stdout.destroyed).toBe(true);
    expect(running.killed).toBe(true);
  } finally {
    await containers.shutdown();
  }
}, 120_000);
