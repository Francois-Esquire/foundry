import { describe, expect, test } from "vitest";
import { startScript } from "./helpers/child-script";

describe("startScript", () => {
  test("reads lines in order, then the exit", async () => {
    const child = await startScript(
      'console.log("one"); console.log(process.argv[2]);',
      ["two"]
    );
    try {
      expect(await child.line()).toBe("one");
      expect(await child.line()).toBe("two");
      await child.exited();
    } finally {
      await child.stop();
    }
  });

  test("a script that fails before printing rejects the wait at once", async () => {
    const child = await startScript('throw new Error("broken");', []);
    try {
      const started = Date.now();
      await expect(child.line()).rejects.toThrow("exited with 1");
      expect(Date.now() - started).toBeLessThan(5000);
      await expect(child.exited()).rejects.toThrow("exited with 1");
    } finally {
      await child.stop();
    }
  });

  test("stop kills, after a grace period, a script that ignores SIGTERM", async () => {
    const child = await startScript(
      'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);',
      []
    );
    try {
      expect(await child.line()).toBe("ready");
      const started = Date.now();
      await child.stop(200);
      expect(Date.now() - started).toBeLessThan(5000);
      await expect(child.exited(1000)).rejects.toThrow("exited with null");
    } finally {
      await child.stop(0);
    }
  });

  test("a wait that timed out leaves the next line to the next wait", async () => {
    const child = await startScript(
      'setTimeout(() => console.log("late"), 300); setInterval(() => {}, 1000);',
      []
    );
    try {
      await expect(child.line(50)).rejects.toThrow("no line in 50 ms");
      expect(await child.line()).toBe("late");
    } finally {
      await child.stop();
    }
  });

  test("a wait is bounded, and stop kills and reaps a script that hangs", async () => {
    const child = await startScript("setInterval(() => {}, 1000);", []);
    await expect(child.line(100)).rejects.toThrow("no line in 100 ms");
    await child.stop();
    await expect(child.exited(1000)).rejects.toThrow("exited with null");
  });
});
