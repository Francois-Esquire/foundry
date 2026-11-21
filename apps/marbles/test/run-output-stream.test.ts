import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelMessage } from "@foundry/workflows/channels";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RunOutput, runOutputStream } from "~/lib/state/output";

const descriptors = vi.hoisted(() => new Set<number>());

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    closeSync(fd: number) {
      fs.closeSync(fd);
      descriptors.delete(fd);
    },
    openSync(...args: Parameters<typeof fs.openSync>) {
      const fd = fs.openSync(...args);
      if (String(args[0]).endsWith("rn-buffered.jsonl")) {
        descriptors.add(fd);
      }
      return fd;
    },
  };
});

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marbles-output-stream-"));
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

const ORIGIN = { at: "2026-11-20T00:00:00.000Z", stepId: "greet" };

it("ends at once, with nothing, for a run that has no saved output", async () => {
  const reader = runOutputStream(root, "rn-missing").getReader();
  await expect(reader.read()).resolves.toEqual({
    done: true,
    value: undefined,
  });
});

it("follows a step's text with the path it came from, leaves out lines no step wrote, and stops following when cancelled", async () => {
  const output = new RunOutput(
    join(root, "workspace"),
    "rn-live",
    "flow",
    () => undefined
  );
  output.text("[step] flow.greet started\n");
  output.text("name? ", { ...ORIGIN, path: ["flow", "greet"] });
  const reader = runOutputStream(root, "rn-live").getReader();
  const first = await reader.read();
  expect(first.value).toEqual({
    _tag: "chunk",
    chunk: {
      ...ORIGIN,
      path: ["flow", "greet"],
      payload: { kind: "text", text: "name? " },
    },
  } satisfies ChannelMessage);
  const waiting = reader.read();
  await reader.cancel();
  await expect(waiting).resolves.toMatchObject({ done: true });
  output.finish("completed");
});

it.each([
  { method: "cancel", phase: "buffered" },
  { method: "abort", phase: "buffered" },
  { method: "cancel", phase: "waiting" },
  { method: "abort", phase: "waiting" },
] as const)(
  "closes the saved-output reader on $method while $phase",
  async ({ method, phase }) => {
    const output = new RunOutput(
      join(root, "workspace"),
      "rn-buffered",
      "flow",
      () => undefined
    );
    if (phase === "buffered") {
      output.text("name? ", { ...ORIGIN, path: ["flow", "greet"] });
    }
    const abort = new AbortController();
    const stream = runOutputStream(root, "rn-buffered", abort.signal);
    const reader = stream.getReader();
    const waiting = phase === "waiting" ? reader.read() : undefined;
    await vi.waitFor(() => expect(descriptors.size).toBe(1));
    if (method === "cancel") {
      await reader.cancel();
    } else {
      abort.abort();
    }
    await vi.waitFor(() => expect(descriptors.size).toBe(0));
    if (waiting !== undefined) {
      await expect(waiting).resolves.toMatchObject({ done: true });
    }
    await reader.cancel();
    output.finish("completed");
  }
);
