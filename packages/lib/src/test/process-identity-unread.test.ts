import { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";

const system = vi.hoisted(() => ({ unread: new Set<number>() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: ((command: string, args: readonly string[], options: object) => {
      const pids = (args.at(-1) ?? "").split(",").map(Number);
      if (command === "ps" && pids.some((pid) => system.unread.has(pid))) {
        return {
          output: [],
          pid: 0,
          signal: null,
          status: 1,
          stderr: "",
          stdout: "",
        };
      }
      return actual.spawnSync(command, args, options);
    }) as typeof actual.spawnSync,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      const file = String(path);
      const stat =
        file.startsWith("/proc/") && file.endsWith("/stat")
          ? Number(file.slice("/proc/".length, -"/stat".length))
          : undefined;
      if (stat !== undefined && system.unread.has(stat)) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return (actual.readFileSync as (...args: unknown[]) => unknown)(
        path,
        ...rest
      );
    }) as typeof actual.readFileSync,
  };
});

const { isGone, startedAt } = await import("../node/process-identity");

const children: ReturnType<typeof spawn>[] = [];

afterEach(() => {
  system.unread.clear();
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
});

it("does not take a live owner for gone when a read of its start leaves it out", () => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  children.push(child);
  const pid = child.pid ?? 0;
  const started = startedAt(pid);
  expect(typeof started).toBe("string");
  system.unread.add(pid);
  expect(startedAt(pid)).toBeUndefined();
  expect(isGone({ pid, started: started ?? null })).toBe(false);
});

it("still takes an owner for gone once its pid answers no signal", async () => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  const pid = child.pid ?? 0;
  const started = startedAt(pid);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  system.unread.add(pid);
  expect(isGone({ pid, started: started ?? null })).toBe(true);
});
